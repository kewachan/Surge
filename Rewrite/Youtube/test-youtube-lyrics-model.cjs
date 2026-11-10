const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");

async function load(model) {
  const inline = (name) => fs.readFileSync(path.join(__dirname, name), "utf8").replace(/^export /gm, "");
  let source = fs.readFileSync(path.join(__dirname, "youtube.lyrics.worker.js"), "utf8")
    .replace(/^import \{[^\n]+\} from "\.\/youtube\.prewarm\.shared\.js";$/m, inline("youtube.prewarm.shared.js"))
    .replace(/^import \{[^\n]+\} from "\.\/youtube\.chinese\.js";$/m, inline("youtube.chinese.js"));
  if (model) source = source.replace(/const AI_MODEL = "[^"]+";/, `const AI_MODEL = ${JSON.stringify(model)};`);
  return import(`data:text/javascript;base64,${Buffer.from(source + "\n//# sourceURL=lyrics-model-worker.mjs").toString("base64")}`);
}
const completion = (translations) => ({choices: [{finish_reason: "stop", message: {
  role: "assistant", content: JSON.stringify({translations}),
}}]});

test("replacement model uses its supported JSON schema without reasoning-only parameters", async () => {
  const worker = await load(), texts = ["Do not leave me alone.", "We will return together."];
  let calls = 0;
  const result = await worker.__test.translateLyrics(texts, "en", "zh-TW", {AI: {run: async (model, input) => {
    calls++;
    assert.equal(model, "@cf/aisingapore/gemma-sea-lion-v4-27b-it");
    assert.equal(input.chat_template_kwargs, undefined);
    assert.equal(input.response_format.type, "json_schema");
    const format = input.response_format.json_schema;
    assert.equal(format.type, "object");
    assert.equal(format.properties.translations.minItems, texts.length);
    assert.equal(format.properties.translations.maxItems, texts.length);
    assert.equal(format.additionalProperties, false);
    assert(!input.messages.some((message) => message.content.includes("/no_think")));
    return {response: JSON.stringify({translations: ["不要丟下我獨自一人。", "我們會一起回來。"]})};
  }}});
  assert.equal(calls, 1);
  assert.deepEqual(result.translations, ["不要丟下我獨自一人。", "我們會一起回來。"]);
  assert.equal(result.provider, "cloudflare-ai");
});

test("OpenAI-shaped incomplete output retries bounded smaller batches without changing order", async () => {
  const worker = await load(), calls = [];
  const result = await worker.__test.translateLyricsAdaptive(["One", "Two", "Three", "Four"], "en", "zh-TW", {
    AI: {run: async (_, input) => {
      const texts = JSON.parse(input.messages[1].content.match(/Target lines JSON: (.+)$/m)[1]);
      calls.push(texts);
      if (texts.length === 4) return {choices: [{finish_reason: "length", message: {content: '{"translations":['}}]};
      return completion(texts.map((text) => `譯文 ${text}`));
    }},
  });
  assert.deepEqual(calls, [["One", "Two", "Three", "Four"], ["One", "Two"], ["Three", "Four"]]);
  assert.deepEqual(result.translations, ["譯文 One", "譯文 Two", "譯文 Three", "譯文 Four"]);
});

test("model migration separates Worker cache identities while retaining existing entries and TTL", async () => {
  const current = await load(), previous = await load("@cf/qwen/qwen3-30b-a3b-fp8");
  const oldCaches = global.caches, entries = new Map(), texts = ["Wait for me"];
  global.caches = {default: {
    match: async (request) => entries.get(request.url)?.clone(),
    put: async (request, response) => entries.set(request.url, response.clone()),
  }};
  try {
    let calls = 0;
    const env = {AI: {run: async (model) => {
      calls++; return completion([model === "@cf/aisingapore/gemma-sea-lion-v4-27b-it" ? "請等我。" : "等等我。"]);
    }}};
    await previous.__test.translateCached(texts, "en", "zh-TW", env);
    const legacyKey = await previous.__test.cacheRequest(texts, "en", "zh-TW");
    const key = await current.__test.cacheRequest(texts, "en", "zh-TW");
    assert.notEqual(key.identifier, legacyKey.identifier);
    const fresh = await current.__test.translateCached(texts, "en", "zh-TW", env);
    assert.deepEqual(fresh.translations, ["請等我。"]);
    assert.equal(fresh.cacheStatus, "MISS");
    assert.equal((await current.__test.translateCached(texts, "en", "zh-TW", env)).cacheStatus, "HIT");
    assert.equal(calls, 2);
    assert.equal(entries.size, 2, "migration must not delete existing caches");
    assert.equal(entries.get(key.request.url).headers.get("cache-control"), "public, max-age=1209600");
  } finally { global.caches = oldCaches; }
});

test("new-model errors retain a bounded non-cacheable failure for the existing client fallback", async () => {
  const worker = await load(), oldCaches = global.caches;
  let calls = 0, writes = 0;
  global.caches = {default: {match: async () => null, put: async () => { writes++; }}};
  const token = "b".repeat(64);
  try {
    const response = await worker.default.fetch(new Request("https://worker.test/lyrics", {
      method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify({texts: ["A new lyric line"], source: "en", target: "zh-Hant"}),
    }), {LYRICS_ACCESS_TOKEN: token, AI: {run: async () => { calls++; throw new Error("synthetic model outage"); }}});
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "Translation Failed");
    assert.equal(calls, 1);
    assert.equal(writes, 0);
  } finally { global.caches = oldCaches; }
});

test("a whole untranslated Thai batch fails once without caching a false AI success", async () => {
  const worker = await load(), oldCaches = global.caches;
  const texts = ["ฉันยิ้มให้เธอ ทั้งที่ในใจยังร้องไห้", "ฉันยอมเป็นคนแพ้ ดีกว่าทำให้เธอเสียใจ"];
  let calls = 0, writes = 0;
  global.caches = {default: {match: async () => null, put: async () => { writes++; }}};
  try {
    await assert.rejects(worker.__test.translateCached(texts, "auto", "zh-TW", {AI: {run: async () => {
      calls++; return completion(texts);
    }}}), (error) => error.code === "AI_UNTRANSLATED");
    assert.equal(calls, 1, "untranslated content must go to the existing client fallback without extra model retries");
    assert.equal(writes, 0);
    const chinese = ["原有繁體歌詞！"];
    const result = await worker.__test.translateLyrics(chinese, "auto", "zh-TW", {AI: {run: async () => completion(chinese)}});
    assert.deepEqual(result.translations, chinese, "already-correct Chinese must retain the original preservation rule");
  } finally { global.caches = oldCaches; }
});

test("a partly copied Thai batch fails once without a recursive retry or a fourteen-day cache write", async () => {
  const worker = await load(), oldCaches = global.caches;
  const texts = ["ฉันยิ้มให้เธอ ทั้งที่ในใจยังร้องไห้", "ฉันยอมเป็นคนแพ้ ดีกว่าทำให้เธอเสียใจ"];
  try {
    for (const target of ["zh-TW", "zh-CN"]) {
      let calls = 0, writes = 0;
      global.caches = {default: {match: async () => null, put: async () => { writes++; }}};
      await assert.rejects(worker.__test.translateCached(texts, "auto", target, {AI: {run: async () => {
        calls++; return completion([target === "zh-CN" ? "我对你微笑。" : "我對你微笑。", texts[1]]);
      }}}), (error) => error.code === "AI_UNTRANSLATED");
      assert.equal(calls, 1); assert.equal(writes, 0);
    }
  } finally { global.caches = oldCaches; }
});

test("Chinese originals, correct repeated translations and embedded foreign names remain cacheable", async () => {
  const worker = await load(), oldCaches = global.caches;
  const thai = "แม้ฝนจะตก ฉันก็ยังรอเธอ", translated = "即使下雨，我仍會等你。";
  const cases = [
    {texts: ["原有繁體歌詞！", thai], translations: ["原有繁體歌詞！", translated]},
    {texts: [thai, thai], translations: [translated, translated]},
    {texts: ["ฉันคิดถึงเมย์", "ฉันจะรอ Lisa", "Lisa", "BLACKPINK"], translations: ["我想念เมย์", "我會等待 Lisa", "Lisa", "BLACKPINK"]},
    {texts: ['คืนนี้ฉันฟังเพลง "รักแรก"'], translations: ["今晚我在聽《รักแรก》。"]},
    {texts: ["原有繁體歌詞！", "Rock & Roll"], translations: ["原有繁體歌詞！", "Rock & Roll"]},
  ];
  try {
    for (const item of cases) {
      const cache = new Map(); let calls = 0;
      global.caches = {default: {match: async (request) => cache.get(request.url)?.clone(), put: async (request, response) => cache.set(request.url, response.clone())}};
      const env = {AI: {run: async () => { calls++; return completion(item.translations); }}};
      const first = await worker.__test.translateCached(item.texts, "auto", "zh-TW", env);
      assert.deepEqual(first.translations, item.translations); assert.equal(first.cacheStatus, "MISS");
      assert.equal((await worker.__test.translateCached(item.texts, "auto", "zh-TW", env)).cacheStatus, "HIT");
      assert.equal(calls, 1); assert.equal(cache.size, 1);
      assert.equal([...cache.values()][0].headers.get("cache-control"), "public, max-age=1209600");
    }
    assert.deepEqual((await worker.__test.translateLyrics([thai], "th", "th", {AI: {run: async () => completion([thai])}})).translations, [thai]);
  } finally { global.caches = oldCaches; }
});

test("an untranslated Thai line is rejected even beside a correctly retained Chinese original", async () => {
  const worker = await load();
  const texts = ["原有繁體歌詞！", "ฉันยิ้มให้เธอ ทั้งที่ในใจยังร้องไห้", "ฉันยอมเป็นคนแพ้ ดีกว่าทำให้เธอเสียใจ"];
  await assert.rejects(worker.__test.translateLyrics(texts, "auto", "zh-TW", {AI: {run: async () => completion([
    texts[0], "我對你微笑。", texts[2],
  ])}}), (error) => error.code === "AI_UNTRANSLATED");
});

test("a whole-line Thai name is intentionally ambiguous and takes the same conservative fallback", async () => {
  const worker = await load();
  await assert.rejects(worker.__test.translateLyrics(["ฉันคิดถึงเธอ", "ลิซ่า"], "auto", "zh-TW", {
    AI: {run: async () => completion(["我想念你。", "ลิซ่า"])},
  }), (error) => error.code === "AI_UNTRANSLATED");
});

test("a rejected partial Thai response reaches native Google fallback without saving an AI cache", async () => {
  const worker = await load(), {loadClient, lyricDocument} = require("./test-youtube-lyrics-order.cjs");
  const oldCaches = global.caches, token = "d".repeat(64), events = [];
  const texts = ["ฉันยิ้มให้เธอ ทั้งที่ในใจยังร้องไห้", "ฉันยอมเป็นคนแพ้ ดีกว่าทำให้เธอเสียใจ"];
  const seed = loadClient(), input = lyricDocument(seed.client, texts);
  let calls = 0, writes = 0;
  global.caches = {default: {match: async () => null, put: async () => { writes++; }}};
  try {
    const run = loadClient({input, token, httpClient: {
      post(request, callback) {
        events.push("worker");
        worker.default.fetch(new Request("https://worker.test/lyrics", {method: "POST", headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        }, body: request.body}), {LYRICS_ACCESS_TOKEN: token, AI: {run: async () => {
          calls++; return completion(["我對你微笑。", texts[1]]);
        }}}).then(async (response) => callback(null, {status: response.status}, await response.text()), callback);
      },
      get(request, callback) {
        events.push("google");
        const q = new URL(request.url).searchParams.get("q");
        const text = q.split(/(\n\[\[YTL:\d+\]\]\n)/).map((part) => /^\n\[\[YTL:\d+\]\]\n$/.test(part) ? part : "谷歌譯文").join("");
        callback(null, {status: 200}, JSON.stringify([[[text]]]));
      },
    }});
    await run.client.main();
    assert.deepEqual(events, ["worker", "google"]); assert.equal(calls, 1); assert.equal(writes, 0);
    assert(Buffer.from(run.output().body).includes(Buffer.from("Translated by Google Translate")));
    assert(!run.store.has(run.client.cacheKey(texts, "zh-Hant")));
  } finally { global.caches = oldCaches; }
});
