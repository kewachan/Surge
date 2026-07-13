// Translate YouTube srv3 captions with Google's public web translation endpoint.
// No account or API key is required. Public endpoint limits still apply.

const TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MAX_ENCODED_QUERY_CHARS = 14000;
const CONCURRENCY = 48;

function getQueryValue(url, name) {
  const match = url.match(new RegExp(`[?&]${name}=([^&#]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function mapTargetLanguage(language) {
  return {"zh-Hant": "zh-TW", "zh-Hans": "zh-CN"}[language] || language;
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

function separator(index) {
  return `\n[[YTS:${index}]]\n`;
}

function buildBatches(captions) {
  const batches = [];
  let items = [];
  let query = "";
  captions.forEach((caption, index) => {
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

function fetchTranslation(query, source, target) {
  const url = `${TRANSLATE_ENDPOINT}?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(query)}`;
  return new Promise((resolve, reject) => {
    $httpClient.get({url, timeout: 7, headers: {Accept: "application/json"}}, (error, response, body) => {
      if (error) return reject(error);
      try {
        const result = JSON.parse(body);
        const status = response.status || response.statusCode;
        if (status !== 200 || !Array.isArray(result?.[0])) throw new Error(`Google Translate status ${status}`);
        resolve(result[0].map((part) => part?.[0] || "").join(""));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function translateBatches(batches, captions, source, target) {
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      try {
        const translated = await fetchTranslation(batch.query, source, target);
        const parts = translated.split(/\s*\[\[YTS:\s*\d+\s*\]\]\s*/g);
        if (parts.length !== batch.items.length) continue;
        batch.items.forEach((item, index) => { captions[item.captionIndex].translated = parts[index].trim(); });
      } catch (error) {
        console.log(`Google caption batch failed: ${error}`);
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(CONCURRENCY, batches.length)}, worker));
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
    while ((part = segment.exec(match[2]))) pieces.push(decodeXml(part[1]));
    const text = pieces.join("").replace(/\s+/g, " ").trim();
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
    console.log(`Google caption translation failed: ${error}`);
    $done({});
  });
}
