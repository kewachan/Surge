// Translate YouTube srv3 captions through the project translation Worker.
// Only caption text and language settings are sent to the Worker.

const WORKER_ENDPOINT = "https://caption-translate.hmtw47cv7m.workers.dev/translate";
const MAX_BATCH_ITEMS = 48;
const MAX_BATCH_TOTAL_CHARS = 1600;
const MAX_CAPTION_CHARS = 1000;
const CONCURRENCY = 3;
const RESPONSE_BUDGET_MS = 115000;
const TRANSLATE_TIMEOUT_SECONDS = 110;
const MAX_RETRIES = 3;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 96;
const CACHE_INDEX_KEY = "YouTubeCaption.CacheIndex.v2";

function getQueryValue(url, name) {
  const match = url.match(new RegExp(`[?&]${name}=([^&#]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function mapTargetLanguage(language) {
  const normalized = language.toLowerCase();
  return {"zh-hant": "zh-TW", "zh-tw": "zh-TW", "zh-hans": "zh-CN", "zh-cn": "zh-CN"}[normalized] || language;
}

function cacheKey(query, source, target) {
  let hash = 2166136261;
  const value = `${source}|${target}|${query}`;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `YouTubeCaption.v2.${(hash >>> 0).toString(16)}`;
}

function readCachedParts(key, length) {
  try {
    const cached = JSON.parse($persistentStore.read(key) || "null");
    const fresh = cached && Array.isArray(cached.parts)
      && cached.parts.length === length
      && Date.now() - Number(cached.savedAt || 0) < CACHE_TTL_MS;
    if (fresh) return cached.parts;
    if (cached) $persistentStore.write("", key);
  } catch (_) {
    try { $persistentStore.write("", key); } catch (_) {}
  }
  return null;
}

function writeCachedParts(key, parts) {
  try {
    const savedAt = Date.now();
    $persistentStore.write(JSON.stringify({savedAt, parts}), key);
    const storedIndex = JSON.parse($persistentStore.read(CACHE_INDEX_KEY) || "[]");
    const index = (Array.isArray(storedIndex) ? storedIndex : [])
      .filter((item) => item?.key && item.key !== key && savedAt - Number(item.savedAt || 0) < CACHE_TTL_MS);
    index.push({key, savedAt});
    while (index.length > CACHE_LIMIT) {
      const expired = index.shift();
      if (expired?.key) $persistentStore.write("", expired.key);
    }
    $persistentStore.write(JSON.stringify(index), CACHE_INDEX_KEY);
  } catch (_) {}
}

function rewriteCaptionRequest(url) {
  const target = getQueryValue(url, "tlang");
  if (!target) return url;
  return url.replace(/([?&])tlang=([^&#]*)/, (_, separator, value) =>
    `${separator}enhance_tlang=${encodeURIComponent(mapTargetLanguage(decodeURIComponent(value)))}`,
  );
}

function decodeXml(text) {
  return text
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function encodeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildBatches(captions) {
  const batches = [];
  let items = [];
  let texts = [];
  let totalCharacters = 0;

  function flush() {
    if (items.length) batches.push({items, texts});
    items = [];
    texts = [];
    totalCharacters = 0;
  }

  captions.forEach((caption, index) => {
    if (!caption.text || caption.text.length > MAX_CAPTION_CHARS) return;
    if (items.length && (items.length >= MAX_BATCH_ITEMS || totalCharacters + caption.text.length > MAX_BATCH_TOTAL_CHARS)) flush();
    items.push({captionIndex: index});
    texts.push(caption.text);
    totalCharacters += caption.text.length;
  });
  flush();
  return batches;
}

function requestTranslation(texts, source, target, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    $httpClient.post({
      url: WORKER_ENDPOINT,
      timeout: typeof $loon !== "undefined" ? timeoutSeconds * 1000 : timeoutSeconds,
      headers: {Accept: "application/json", "Content-Type": "application/json"},
      body: JSON.stringify({texts, source, target, purpose: "captions"}),
    }, (error, response, body) => {
      if (error) return reject(error);
      try {
        const status = response.status || response.statusCode;
        if (status !== 200) {
          const statusError = new Error(`Worker status ${status}`);
          statusError.status = status;
          throw statusError;
        }
        const result = JSON.parse(body);
        if (!Array.isArray(result?.translations) || result.translations.length !== texts.length) {
          throw new Error("Invalid Worker translation response");
        }
        resolve(result.translations.map((text) => String(text || "")));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function fetchTranslation(texts, source, target, deadline) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError || new Error("Caption translation time budget exhausted");
    try {
      const timeout = Math.max(1, Math.min(TRANSLATE_TIMEOUT_SECONDS, Math.ceil(remaining / 1000)));
      return await requestTranslation(texts, source, target, timeout);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || Number(error?.status) !== 429) break;
      const delay = 5000;
      if (Date.now() + delay >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error("Caption translation failed");
}

async function translateBatches(batches, captions, source, target) {
  const queue = [...batches];
  const deadline = Date.now() + RESPONSE_BUDGET_MS;
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length && Date.now() < deadline) {
      const batch = queue[cursor++];
      try {
        const key = cacheKey(batch.texts.join("\u001f"), source, target);
        let parts = readCachedParts(key, batch.items.length);
        if (!parts) {
          parts = await fetchTranslation(batch.texts, source, target, deadline);
          writeCachedParts(key, parts);
        }
        batch.items.forEach((item, index) => { captions[item.captionIndex].translated = parts[index].trim(); });
      } catch (error) {
        console.log(`Caption Worker batch failed: ${error}`);
      }
    }
  }
  const work = Promise.all(Array.from({length: Math.min(CONCURRENCY, queue.length)}, worker));
  let timer;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, RESPONSE_BUDGET_MS); })]);
  if (timer) clearTimeout(timer);
}

async function translateCaptionResponse() {
  const target = mapTargetLanguage(getQueryValue($request.url, "enhance_tlang") || getQueryValue($request.url, "tlang"));
  const source = getQueryValue($request.url, "lang") || "auto";
  if (!target || !$response.body) return $done({});

  const body = $response.body;
  const captions = [];
  const paragraph = /<p(\s[^>]*)?>([\s\S]*?)<\/p>/g;
  const segment = /<s(?:\s[^>]*)?>([\s\S]*?)<\/s>/g;
  let match;
  while ((match = paragraph.exec(body))) {
    const pieces = [];
    let part;
    segment.lastIndex = 0;
    while ((part = segment.exec(match[2]))) pieces.push(part[1]);
    // srv3 may contain either word-level <s> nodes or plain text directly
    // inside each timed <p> node.
    const rawText = pieces.length ? pieces.join("") : match[2].replace(/<[^>]*>/g, "");
    const text = decodeXml(rawText).replace(/\s+/g, " ").trim();
    if (text) captions.push({start: match.index, end: paragraph.lastIndex, attributes: match[1] || "", text});
  }
  if (!captions.length) return $done({});

  await translateBatches(buildBatches(captions), captions, source, target);
  let output = "";
  let position = 0;
  captions.forEach((caption) => {
    output += body.slice(position, caption.start);
    output += `<p${caption.attributes}><s ac="0">${encodeXml(caption.translated || caption.text)}</s></p>`;
    position = caption.end;
  });
  output += body.slice(position);
  $done({body: output, headers: {...$response.headers, "Content-Type": "text/xml; charset=utf-8"}});
}

if (typeof $response === "undefined") {
  $done({url: rewriteCaptionRequest($request.url)});
} else {
  translateCaptionResponse().catch((error) => {
    console.log(`Caption Worker translation failed: ${error}`);
    $done({});
  });
}
