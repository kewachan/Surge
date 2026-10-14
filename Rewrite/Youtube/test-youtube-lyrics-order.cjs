const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const clientSource = fs.readFileSync(path.join(__dirname, "youtube.lyrics.js"), "utf8");
const token = "a".repeat(64); // Synthetic test credential, never sent to a live service.
const aiResult = (count) => ({translations: Array.from({length: count}, (_, i) => `譯文${i}`), provider: "cloudflare-ai"});

function loadClient(options = {}) {
  const store = options.store || new Map();
  const events = [];
  let output;
  const context = {
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout,
    $argument: JSON.stringify({lyricsLang: "zh-Hant", lyricsToken: options.token || token}),
    $response: {bodyBytes: options.input},
    $persistentStore: {
      read: (key) => store.get(key) || null,
      write(value, key) { value ? store.set(key, value) : store.delete(key); return true; },
    },
    $httpClient: options.httpClient || {
      post(request, callback) {
        events.push("ai-worker");
        assert.equal(new URL(request.url).pathname, "/lyrics");
        const seconds = options.loon ? request.timeout / 1000 : request.timeout;
        assert(seconds > 6 && seconds <= 6.5, "AI must not be cut off at the old three-second limit");
        const payload = JSON.parse(request.body);
        if (options.failWorker) callback("HTTP request timeout");
        else callback(null, {status: 200}, JSON.stringify(options.workerResult || aiResult(payload.texts.length)));
      },
      get(request, callback) {
        events.push("google");
        assert.equal(events.at(-2), "ai-worker", "Google must follow the AI attempt");
        const q = new URL(request.url).searchParams.get("q");
        const translated = q.split(/(\n\[\[YTL:\d+\]\]\n)/)
          .map((part) => /^\n\[\[YTL:\d+\]\]\n$/.test(part) ? part : "谷歌譯文").join("");
        callback(null, {status: 200}, JSON.stringify([[[translated]]]));
      },
    },
    $done(result) { output = result; },
  };
  if (options.loon) context.$loon = {};
  const source = clientSource.replace("  main().catch((error) => {", [
    "  globalThis.client = {cacheKey, readCache, writeCache, fetchTranslations, main, encodeField, join};",
    "  return;",
    "  main().catch((error) => {",
  ].join("\n"));
  vm.runInNewContext(source, context);
  return {client: context.client, events, store, output: () => output};
}

function lyricDocument(client, texts) {
  const encoder = new TextEncoder();
  const items = texts.map((text) => client.encodeField(1, client.join([
    client.encodeField(1, encoder.encode(text)), client.encodeField(2, new Uint8Array()),
  ])));
  return client.encodeField(465160965, client.encodeField(4, client.join(items)));
}

async function verifyClient() {
  const texts = ["A gentle breeze", "An evening sky"];
  const first = loadClient();
  const key = first.client.cacheKey(texts, "zh-Hant");
  first.client.writeCache(key, aiResult(2));
  first.events.length = 0;
  const input = lyricDocument(first.client, texts);
  const cached = loadClient({input, store: first.store});
  await cached.client.main();
  assert.deepEqual(cached.events, [], "a saved AI cache must bypass both services");
  assert(Buffer.from(cached.output().body).includes(Buffer.from("Translated by Cloudflare AI")));

  for (const provider of ["google-translate", "google-translate-provisional"]) {
    const store = new Map([[key, JSON.stringify({ ...aiResult(2), provider, savedAt: Date.now(), expiresAt: Date.now() + 86400000 })]]);
    const client = loadClient({input, store});
    await client.client.main();
    assert.deepEqual(client.events, ["ai-worker"], "old Google caches must not suppress the AI attempt");
    assert.equal(JSON.parse(store.get(key)).provider, "cloudflare-ai");
  }

  const fallback = loadClient({input, failWorker: true});
  await fallback.client.main();
  assert.deepEqual(fallback.events, ["ai-worker", "google"]);
  assert.equal(fallback.store.has(key), false, "Google fallback must not become a long-lived AI cache");
  assert(Buffer.from(fallback.output().body).includes(Buffer.from("Translated by Google Translate")));
  const retry = loadClient({input, store: fallback.store});
  await retry.client.main();
  assert.deepEqual(retry.events, ["ai-worker"], "a retry must attempt AI again");

  const legacyWorker = loadClient({input, workerResult: {...aiResult(2), provider: "google-translate-provisional"}});
  await legacyWorker.client.main();
  assert.deepEqual(legacyWorker.events, ["ai-worker", "google"]);
  assert.equal(legacyWorker.store.has(key), false);
  const loon = loadClient({input, failWorker: true, loon: true});
  await loon.client.main();
  assert.deepEqual(loon.events, ["ai-worker", "google"]);

  let harBatches = 0;
  if (process.env.LYRICS_HAR_PATH) {
    const entries = JSON.parse(fs.readFileSync(process.env.LYRICS_HAR_PATH, "utf8")).log.entries;
    for (const entry of entries) {
      if (new URL(entry.request.url).hostname !== "youtube-lyrics-translate.hmtw47cv7m.workers.dev") continue;
      const payload = JSON.parse(entry.request.postData.text);
      const replay = loadClient();
      const result = await replay.client.fetchTranslations(payload.texts, payload.target, Date.now() + 9000, token);
      assert.equal(result.provider, "cloudflare-ai");
      assert.deepEqual(replay.events, ["ai-worker"]);
      assert.equal(result.translations.length, payload.texts.length);
      harBatches++;
    }
  }
  return {aiCacheFirst: true, aiWorkerSecond: true, googleLast: true,
    googleCacheCannotMaskAI: true, retryUpgradesToAI: true, legacyWorkerRejected: true,
    surgeAndLoonBudgets: true, harBatches};
}

async function verifyWorker() {
  const source = fs.readFileSync(path.join(__dirname, "youtube.lyrics.worker.js"), "utf8");
  const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const values = new Map();
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = {default: {
    async match(request) { return values.get(request.url)?.clone(); },
    async put(request, response) { values.set(request.url, response.clone()); },
  }};
  globalThis.fetch = () => { throw new Error("Lyrics Worker must never call Google"); };
  try {
    const texts = ["Test lyric one", "Test lyric two"];
    let aiCalls = 0;
    const env = {AI: {async run() { aiCalls++; return aiResult(2); }}, LYRICS_ACCESS_TOKEN: token};
    const pending = [];
    const context = {waitUntil: (work) => pending.push(work)};
    const first = await worker.__test.translateCached(texts, "auto", "zh-TW", env, context);
    assert.equal(first.provider, "cloudflare-ai");
    assert.equal(first.cacheStatus, "MISS");
    const hit = await worker.__test.translateCached(texts, "auto", "zh-TW", env, context);
    assert.equal(hit.cacheStatus, "HIT");
    assert.equal(aiCalls, 1);

    values.clear();
    const key = await worker.__test.cacheRequest(texts, "auto", "zh-TW");
    values.set(key.request.url, Response.json({...aiResult(2), provider: "google-translate"}));
    await worker.__test.translateCached(texts, "auto", "zh-TW", env, context);
    assert.equal(aiCalls, 2, "server cache must contain actual AI results");

    values.clear();
    let finishAI;
    const deferred = new Promise((resolve) => { finishAI = resolve; });
    env.AI.run = () => { aiCalls++; return deferred; };
    const cold = worker.__test.translateCached(texts, "auto", "zh-TW", env, context);
    await new Promise((resolve) => setImmediate(resolve));
    const same = worker.__test.translateCached(texts, "auto", "zh-TW", env, context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aiCalls, 3, "same-isolate duplicate requests must share their AI attempt");
    finishAI(aiResult(2));
    assert.equal((await cold).provider, "cloudflare-ai");
    await same;
    await Promise.all(pending);
    assert(values.has(key.request.url), "AI result must be cached even after the client stops waiting");

    values.clear();
    env.AI.run = async () => { throw new Error("AI temporarily unavailable"); };
    const request = () => new Request("https://worker.test/lyrics", {method: "POST",
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify({purpose: "lyrics", texts, source: "auto", target: "zh-Hant"})});
    assert.equal((await worker.default.fetch(request(), env, context)).status, 502);
    env.AI.run = async () => aiResult(2);
    const recovered = await worker.default.fetch(request(), env, context);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get("X-YouTube-Translation-Provider"), "cloudflare-ai");
    await Promise.all(pending);
    return {aiOnlyWorker: true, aiCacheHit: true, inFlightReuse: true, lateAICache: true, failureRecovery: true};
  } finally { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; }
}

module.exports = {loadClient, lyricDocument};
if (require.main === module) (async () => {
  console.log(JSON.stringify({worker: await verifyWorker(), client: await verifyClient()}, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
