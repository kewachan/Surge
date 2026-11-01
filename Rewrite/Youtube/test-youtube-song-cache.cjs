const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs");
const {loadClient, lyricDocument} = require("./test-youtube-lyrics-order.cjs");
const texts = Array.from({length: 34}, (_, i) => `Original song line ${i}`);
const videoId = "abcdefghijk";
function runClient(handler, options = {}) {
  const calls = [], store = options.store || new Map([["YouTubeLyrics.Prewarm.Active.v1", JSON.stringify({videoId, savedAt: Date.now() - (options.fresh ? 0 : 20000)})]]);
  const seed = loadClient(), input = lyricDocument(seed.client, texts);
  const run = loadClient({input, store, httpClient: {
    post(request, callback) { const payload = JSON.parse(request.body); calls.push({path: new URL(request.url).pathname, payload}); handler(request, payload, callback); },
    get(request, callback) { if (options.google) options.google(request, callback); else throw new Error("Unexpected Google fallback"); }
  }});
  return {run, store, calls, input};
}
function ai(payload, extra = {}) { return {provider: "cloudflare-ai", translations: payload.texts.map((_, i) => `整首譯文${i}`), ...extra}; }
test("34 native lyric lines use one whole-song cache request, then only local AI caches", async () => {
  const first = runClient((request, payload, callback) => {
    assert.equal(new URL(request.url).pathname, "/lyrics/prewarm/result");
    assert.equal(payload.videoId, videoId); assert.equal(payload.texts.length, 34);
    callback(null, {status: 200}, JSON.stringify(ai(payload, {status: "complete", target: "zh-TW"})));
  });
  await first.run.client.main(); assert.equal(first.calls.length, 1);
  assert(Buffer.from(first.run.output().body).includes(Buffer.from("Translated by Cloudflare AI")));
  const before = JSON.stringify([...first.store]);
  const second = loadClient({input: first.input, store: first.store, httpClient: {post() { throw new Error("Local AI cache must win"); }}});
  await second.client.main(); assert(second.output().body);
  assert.equal(JSON.stringify([...first.store]), before, "opening cached lyrics must not extend their 14-day lifetime");
});
test("partial song results request AI only for missing lines and rebuild the original batch cache", async () => {
  const first = runClient((request, payload, callback) => {
    if (new URL(request.url).pathname.endsWith("/result")) {
      const result = ai(payload, {status: "partial", target: "zh-TW"}); result.translations[33] = null;
      callback(null, {status: 200}, JSON.stringify(result));
    } else {
      assert.deepEqual(payload.texts, [texts[33]]);
      callback(null, {status: 200}, JSON.stringify(ai(payload)));
    }
  });
  await first.run.client.main(); assert.equal(first.calls.length, 2);
  const second = loadClient({input: first.input, store: first.store, httpClient: {post() { throw new Error("Regrouped AI cache was not saved"); }}});
  await second.client.main(); assert(second.output().body);
});
test("pending, wrong-language and non-AI song caches preserve the existing AI path", async () => {
  for (const mode of ["pending", "wrong-language", "google", "bad-complete", "not-found"]) {
    const first = runClient((request, payload, callback) => {
      if (new URL(request.url).pathname.endsWith("/result")) {
        const result = ai(payload, {status: "complete", target: "zh-TW"});
        if (mode === "pending") result.status = "pending";
        if (mode === "wrong-language") result.target = "ja";
        if (mode === "google") result.provider = "google-translate";
        if (mode === "bad-complete") result.translations[0] = null;
        callback(null, {status: mode === "not-found" ? 404 : 200}, JSON.stringify(result));
      } else callback(null, {status: 200}, JSON.stringify(ai(payload)));
    });
    await first.run.client.main(); assert(first.run.output().body, mode);
    assert.equal(first.calls.filter((call) => call.path === "/lyrics").length, 3, mode);
  }
});
test("an immediate lyrics opening skips speculative cache waiting", async () => {
  const first = runClient((request, payload, callback) => {
    assert.equal(new URL(request.url).pathname, "/lyrics");
    callback(null, {status: 200}, JSON.stringify(ai(payload)));
  }, {fresh: true});
  await first.run.client.main(); assert.equal(first.calls.length, 3);
});
test("a hung whole-song lookup is bounded at one second before normal AI proceeds", async () => {
  const start = Date.now();
  const first = runClient((request, payload, callback) => {
    if (new URL(request.url).pathname.endsWith("/result")) return;
    callback(null, {status: 200}, JSON.stringify(ai(payload)));
  });
  await first.run.client.main(); assert(first.run.output().body);
  assert(Date.now() - start >= 950); assert(Date.now() - start < 1800);
});

test("partial AI plus Google fallback never persists a mixed batch as an AI cache", async () => {
  const first = runClient((request, payload, callback) => {
    if (new URL(request.url).pathname.endsWith("/result")) {
      const result = ai(payload, {status: "partial", target: "zh-TW"}); result.translations[33] = null;
      callback(null, {status: 200}, JSON.stringify(result));
    } else callback("HTTP request timeout");
  }, {google: (_, callback) => callback(null, {status: 200}, JSON.stringify([[["谷歌尾句"]]]))});
  await first.run.client.main(); assert(first.run.output().body);
  assert(!first.store.has(first.run.client.cacheKey(texts.slice(24), "zh-Hant")));
  assert(first.store.has(first.run.client.cacheKey(texts.slice(0, 12), "zh-Hant")));
});

test("private pw HAR lyric batches collapse into one native cache lookup", {skip: !process.env.PREWARM_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.PREWARM_HAR_PATH, "utf8")).log.entries;
  const originals = [], seen = new Set(); let video, captured = 0;
  for (const entry of entries.slice().reverse()) {
    const url = new URL(entry.request.url);
    if (url.hostname !== "youtube-lyrics-translate.hmtw47cv7m.workers.dev" || url.pathname !== "/lyrics") continue;
    const p = entry.request.postData, payload = JSON.parse(Buffer.from(p.text, p.encoding === "base64" ? "base64" : "utf8").toString());
    if (!payload.prewarmVideoId) continue;
    if (video && video !== payload.prewarmVideoId) continue;
    video = payload.prewarmVideoId; captured++;
    for (const line of payload.texts) if (!seen.has(line)) { originals.push(line); seen.add(line); }
  }
  assert(captured > 1 && originals.length > 12, "HAR must contain multiple native batches with a prewarm hint");
  const seed = loadClient(), input = lyricDocument(seed.client, originals);
  const store = new Map([["YouTubeLyrics.Prewarm.Active.v1", JSON.stringify({videoId: video, savedAt: Date.now() - 20000})]]);
  let requests = 0;
  const run = loadClient({input, store, httpClient: {post(request, callback) {
    requests++; assert(new URL(request.url).pathname === "/lyrics/prewarm/result");
    const payload = JSON.parse(request.body); assert(payload.videoId === video); assert(payload.texts.length === originals.length);
    callback(null, {status: 200}, JSON.stringify({status: "complete", provider: "cloudflare-ai", target: "zh-TW", translations: originals.map(() => "回歸測試譯文")}));
  }, get() { throw new Error("Warm HAR replay must not request Google"); }}});
  await run.client.main(); assert(run.output().body); assert.equal(requests, 1);
});
