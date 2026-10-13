// Translate YouTube srv3 captions through the long-caption work queue with direct Google fallback.
// The queue is rate limited for public use; an optional access token bypasses that public limit.

const TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const CAPTION_WORKER_ENDPOINT = "https://youtube-caption-translate.hmtw47cv7m.workers.dev/caption/jobs";
const MAX_ENCODED_QUERY_CHARS = 6000;
const CONCURRENCY = 3;
const TRANSLATE_TIMEOUT_SECONDS = 2;
const MAX_RETRIES = 0;
const MIN_RETRY_WINDOW_MS = 1200;
const RETRY_DELAY_MS = 200;
const SCRIPT_RESPONSE_BUDGET_MS = 7200;
const MIN_RESPONSE_BUDGET_MS = 1000;
const MAX_RESPONSE_BUDGET_MS = SCRIPT_RESPONSE_BUDGET_MS;
const QUEUE_SUBMIT_TIMEOUT_SECONDS = 3;
const QUEUE_POLL_TIMEOUT_SECONDS = 1;
const QUEUE_DEFAULT_POLL_MS = 250;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 96;
const CACHE_INDEX_KEY = "YouTubeCaption.CacheIndex.v5";

function scriptOptions() {
  const defaults = {captionToken: "", debug: false};
  try {
    if (typeof $argument === "string" && !$argument.includes("{{{")) {
      return {...defaults, ...JSON.parse($argument)};
    }
    if (typeof $argument === "object" && $argument) return {...defaults, ...$argument};
  } catch (_) {}
  return defaults;
}

function validCaptionToken(value) {
  const token = String(value || "").trim();
  return token.length >= 32 && token.length <= 128 && !/\s/.test(token) && token !== "paste-token-here";
}

function debugLog(options, message) {
  if (options.debug) console.log(`YouTube caption: ${message}`);
}

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
  return `YouTubeCaption.v5.${(hash >>> 0).toString(16)}`;
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

function rewrittenResponseHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.toLowerCase();
    if (normalized === "content-type" || normalized === "content-encoding"
      || normalized === "content-length" || normalized === "transfer-encoding") continue;
    output[name] = value;
  }
  output["Content-Type"] = "text/xml; charset=utf-8";
  return output;
}

function separator(index) {
  return `\n[[YTS:${index}]]\n`;
}

function buildBatches(captions, missingOnly = false) {
  const batches = [];
  let items = [];
  let query = "";
  captions.forEach((caption, index) => {
    if (missingOnly && caption.translated) return;
    const addition = `${items.length ? separator(index) : ""}${caption.text}`;
    if (items.length && encodeURIComponent(query + addition).length > MAX_ENCODED_QUERY_CHARS) {
      batches.push({items, query});
      items = [];
      query = "";
    }
    query += `${items.length ? separator(index) : ""}${caption.text}`;
    items.push({captionIndex: index});
  });
  if (items.length) batches.push({items, query});
  return batches;
}

function applyCachedTranslations(captions, source, target) {
  for (const batch of buildBatches(captions)) {
    const parts = readCachedParts(cacheKey(batch.query, source, target), batch.items.length);
    if (!parts) continue;
    batch.items.forEach((item, index) => { captions[item.captionIndex].translated = parts[index].trim(); });
  }
}

function writeResolvedCaches(captions, source, target) {
  for (const batch of buildBatches(captions)) {
    const parts = batch.items.map((item) => String(captions[item.captionIndex].translated || "").trim());
    if (parts.every(Boolean)) writeCachedParts(cacheKey(batch.query, source, target), parts);
  }
}

function captionWorkerRequest(method, url, token, body, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const request = {
      url,
      timeout: typeof $loon !== "undefined" ? timeoutSeconds * 1000 : timeoutSeconds,
      headers: {Accept: "application/json"},
    };
    if (validCaptionToken(token)) request.headers.Authorization = `Bearer ${token.trim()}`;
    if (body !== undefined) {
      request.headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(body);
    }
    const callback = (error, response, responseBody) => {
      if (error) return reject(error);
      try {
        const status = response.status || response.statusCode;
        if (status < 200 || status >= 300) throw new Error(`Caption Worker status ${status}`);
        const parsed = responseBody ? JSON.parse(responseBody) : {};
        resolve(parsed);
      } catch (parseError) {
        reject(parseError);
      }
    };
    if (method === "POST") $httpClient.post(request, callback);
    else $httpClient.get(request, callback);
  });
}

async function translateWithQueue(entries, source, target, token, options, deadline) {
  const created = await captionWorkerRequest("POST", CAPTION_WORKER_ENDPOINT, token, {
    purpose: "captions",
    source,
    target,
    texts: entries.map((entry) => entry.text),
  }, QUEUE_SUBMIT_TIMEOUT_SECONDS);
  if (!/^[0-9a-f-]{36}$/i.test(String(created?.jobId || ""))) throw new Error("Invalid Caption Worker job response");
  if ((created.status === "complete" || created.status === "failed")
    && Array.isArray(created.translations)) return created;

  const statusUrl = `${CAPTION_WORKER_ENDPOINT}/${created.jobId}`;
  const pollMs = Math.max(250, Math.min(2000, Number(created.pollAfterMs) || QUEUE_DEFAULT_POLL_MS));
  let latest = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    if (Date.now() >= deadline) break;
    const remainingSeconds = Math.max(1, Math.min(
      QUEUE_POLL_TIMEOUT_SECONDS,
      Math.ceil((deadline - Date.now()) / 1000),
    ));
    latest = await captionWorkerRequest("GET", statusUrl, token, undefined, remainingSeconds);
    if (!Array.isArray(latest?.translations) || latest.translations.length !== entries.length) {
      throw new Error("Invalid Caption Worker status response");
    }
    debugLog(options, `queue ${latest.status} ${latest.completedBatches || 0}/${latest.batchCount || 0}`);
    if (latest.status === "complete" || latest.status === "failed") return latest;
  }
  return latest;
}

function applyQueuedTranslations(entries, result, captions) {
  if (!Array.isArray(result?.translations)) return 0;
  let applied = 0;
  result.translations.forEach((translation, index) => {
    const text = String(translation || "").trim();
    const entry = entries[index];
    if (!text || !entry) return;
    captions[entry.captionIndex].translated = text;
    applied++;
  });
  return applied;
}

function requestTranslation(query, source, target, timeoutSeconds) {
  const url = `${TRANSLATE_ENDPOINT}?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(query)}`;
  return new Promise((resolve, reject) => {
    $httpClient.get({
      url,
      timeout: typeof $loon !== "undefined" ? timeoutSeconds * 1000 : timeoutSeconds,
      headers: {Accept: "application/json"},
    }, (error, response, body) => {
      if (error) return reject(error);
      try {
        const status = response.status || response.statusCode;
        if (status !== 200) throw new Error(`Google Translate status ${status}`);
        const result = JSON.parse(body);
        if (!Array.isArray(result?.[0])) throw new Error("Invalid Google Translate response");
        resolve(result[0].map((part) => part?.[0] || "").join(""));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function fetchTranslation(query, source, target, deadline) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError || new Error("Caption translation time budget exhausted");
    try {
      const timeout = Math.max(1, Math.min(TRANSLATE_TIMEOUT_SECONDS, Math.ceil(remaining / 1000)));
      return await requestTranslation(query, source, target, timeout);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) break;
      if (Date.now() + RETRY_DELAY_MS + MIN_RETRY_WINDOW_MS >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError || new Error("Caption translation failed");
}

function rebuildBatch(items, captions) {
  return {
    items,
    query: items.map((item, index) => `${index ? separator(item.captionIndex) : ""}${captions[item.captionIndex].text}`).join(""),
  };
}

async function translateBatches(batches, captions, source, target, hardDeadline) {
  if (!batches.length || Date.now() >= hardDeadline) return;
  const queue = [...batches];
  const waves = Math.max(1, Math.ceil(batches.length / CONCURRENCY));
  const retryWindow = (MAX_RETRIES + 1) * TRANSLATE_TIMEOUT_SECONDS * 1000
    + RETRY_DELAY_MS + MIN_RETRY_WINDOW_MS;
  const calculatedBudget = Math.min(
    MAX_RESPONSE_BUDGET_MS,
    Math.max(MIN_RESPONSE_BUDGET_MS, waves * retryWindow),
  );
  const deadline = Math.min(hardDeadline, Date.now() + calculatedBudget);
  const responseBudget = Math.max(0, deadline - Date.now());
  if (!responseBudget) return;
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length && Date.now() < deadline) {
      const batch = queue[cursor++];
      try {
        const key = cacheKey(batch.query, source, target);
        let parts = readCachedParts(key, batch.items.length);
        if (!parts) {
          const translated = await fetchTranslation(batch.query, source, target, deadline);
          parts = translated.split(/\s*\[\[YTS:\s*\d+\s*\]\]\s*/g);
          if (parts.length === batch.items.length) writeCachedParts(key, parts);
        }
        if (parts.length !== batch.items.length) {
          if (batch.items.length > 1) {
            const middle = Math.ceil(batch.items.length / 2);
            queue.push(rebuildBatch(batch.items.slice(0, middle), captions));
            queue.push(rebuildBatch(batch.items.slice(middle), captions));
          }
          continue;
        }
        batch.items.forEach((item, index) => { captions[item.captionIndex].translated = parts[index].trim(); });
      } catch (error) {
        console.log(`Google caption batch failed: ${error}`);
      }
    }
  }
  const work = Promise.all(Array.from({length: Math.min(CONCURRENCY, queue.length)}, worker));
  let timer;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, responseBudget); })]);
  if (timer) clearTimeout(timer);
}

async function translateCaptionResponse() {
  const options = scriptOptions();
  const responseDeadline = Date.now() + SCRIPT_RESPONSE_BUDGET_MS;
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

  applyCachedTranslations(captions, source, target);
  const entries = captions
    .map((caption, captionIndex) => ({captionIndex, text: caption.text, translated: caption.translated}))
    .filter((entry) => !entry.translated);
  if (entries.length) {
    try {
      const queued = await translateWithQueue(
        entries,
        source,
        target,
        options.captionToken,
        options,
        responseDeadline,
      );
      const applied = applyQueuedTranslations(entries, queued, captions);
      debugLog(options, `queue returned ${applied}/${entries.length} captions`);
      writeResolvedCaches(captions, source, target);
    } catch (error) {
      console.log(`Caption Worker queue failed: ${error}`);
    }
  }
  await translateBatches(buildBatches(captions, true), captions, source, target, responseDeadline);
  writeResolvedCaches(captions, source, target);
  let output = "";
  let position = 0;
  captions.forEach((caption) => {
    output += body.slice(position, caption.start);
    output += `<p${caption.attributes}><s ac="0">${encodeXml(caption.translated || caption.text)}</s></p>`;
    position = caption.end;
  });
  output += body.slice(position);
  $done({body: output, headers: rewrittenResponseHeaders($response.headers)});
}

if (typeof $response === "undefined") {
  $done({url: rewriteCaptionRequest($request.url)});
} else {
  translateCaptionResponse().catch((error) => {
    console.log(`Google caption translation failed: ${error}`);
    $done({});
  });
}
