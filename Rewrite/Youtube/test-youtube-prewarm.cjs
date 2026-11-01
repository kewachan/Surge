const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const directory = __dirname;
const token = "a".repeat(64);
const authorization = {Authorization: `Bearer ${token}`};
const sourceUrl = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&name=Track+One&signature=keep";
const xml = '<?xml version="1.0"?><timedtext format="3"><body><p t="123" d="456"><s>Hello &amp; world</s></p><p t="999" d="1000">\n</p></body></timedtext>';
let shared;
async function load(name) {
  let source = fs.readFileSync(path.join(directory, name), "utf8");
  const common = fs.readFileSync(path.join(directory, "youtube.prewarm.shared.js"), "utf8").replace(/^export /gm, "");
  source = source.replace(/^import \{[^\n]+\} from "\.\/youtube\.prewarm\.shared\.js";$/m, common)
    .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
const ready = (async () => {
  shared = await load("youtube.prewarm.shared.js");
  return {caption: await load("youtube.caption.worker.js"), lyrics: await load("youtube.lyrics.worker.js")};
})();
class Namespace {
  constructor(Class) { this.Class = Class; this.objects = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    if (!this.objects.has(id)) {
      const values = new Map();
      const storage = {get: async (key) => values.get(key), put: async (key, value) => {
        assert(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024, "Durable Object KV values must stay below 128KiB");
        values.set(key, structuredClone(value));
      },
        delete: async (key) => values.delete(key), deleteAll: async () => values.clear(), setAlarm: async () => {},
        list: async ({prefix}) => new Map([...values].filter(([key]) => key.startsWith(prefix)))};
      const instance = new this.Class({storage}, {});
      this.objects.set(id, instance);
    }
    return {fetch: (url, init) => this.objects.get(id).fetch(url instanceof Request ? url : new Request(url, init))};
  }
}
function message(body, attempts = 1) {
  return {body, attempts, acked: false, retried: false, ack() { this.acked = true; }, retry(options) { this.retried = options; }};
}
function request(url, body, auth = authorization) {
  return new Request(url, {method: "POST", headers: {...auth, "Content-Type": "application/json"}, body: JSON.stringify(body)});
}
test("durable leases serialize duplicate submissions and survive consumer retries", async () => {
  await ready;
  const namespace = new Namespace(shared.PrewarmJob), sent = [];
  const queue = {send: async (value) => sent.push(value)};
  const id = await shared.identifier({video: "abcdefghijk"});
  await Promise.all(Array.from({length: 5}, () => shared.enqueue(namespace, queue, id, {kind: "source"})));
  assert.equal(sent.length, 1);
  let runs = 0;
  const first = message(sent[0]);
  await shared.consume(first, namespace, async () => { runs++; throw new Error("synthetic"); });
  assert(first.retried);
  await shared.consume(message(sent[0], 2), namespace, async () => { runs++; return {done: true}; });
  await shared.consume(message(sent[0], 3), namespace, async () => { runs++; });
  assert.equal(runs, 2);
  assert.equal((await shared.jobCall(namespace, id, "state")).result.done, true);
});
test("long original/final subtitle documents are chunked below the DO storage limit and survive completion", async () => {
  await ready;
  const namespace = new Namespace(shared.PrewarmJob);
  const body = "長字幕<&>\n".repeat(50000), id = "c".repeat(64);
  await shared.jobCall(namespace, id, "prepare", {work: {body}});
  assert.equal((await shared.jobCall(namespace, id, "run", {})).work.body, body);
  await shared.jobCall(namespace, id, "complete", {result: {body}});
  assert.equal((await shared.jobCall(namespace, id, "state")).result.body, body);
});
test("caption prewarm and immediate CC share the existing Google job and preserve XML", async () => {
  const {caption} = await ready;
  const messages = [], env = {CAPTION_ACCESS_TOKEN: token, CAPTION_PREWARM: new Namespace(caption.CaptionPrewarm),
    CAPTION_JOBS: new Namespace(caption.CaptionJob), CAPTION_QUEUE: {send: async (body) => messages.push(body),
      sendBatch: async (batch) => messages.push(...batch.map((item) => item.body))}};
  const oldFetch = global.fetch; let google = 0;
  global.fetch = async (url, init) => {
    if (new URL(url).hostname === "www.youtube.com") {
      assert.equal(init.redirect, "manual"); assert.equal(init.headers, undefined);
      return new Response(xml);
    }
    google++; return Response.json(["你好世界"]);
  };
  try {
    const created = await (await caption.default.fetch(request("https://worker.test/caption/prewarm", {url: sourceUrl, target: "zh-TW"}), env)).json();
    await caption.default.fetch(request("https://worker.test/caption/prewarm", {url: sourceUrl, target: "zh-TW"}), env);
    assert.equal(messages.length, 1);
    const foreground = await caption.default.fetch(request("https://worker.test/caption/jobs", {purpose: "captions", source: "en", target: "zh-TW", texts: ["Hello & world"]}), env);
    assert.equal(foreground.status, 202);
    await caption.default.queue({messages: [message(messages[0])]}, env);
    assert.equal(messages.filter((item) => !item.prewarm).length, 1, "source and foreground must not enqueue twice");
    await caption.default.queue({messages: messages.filter((item) => !item.prewarm).map((body) => message(body))}, env);
    const url = `https://worker.test/caption/prewarm/${created.jobId}?sourceHash=${encodeURIComponent(shared.fingerprint(xml))}`;
    const result = await (await caption.default.fetch(new Request(url), env)).json();
    assert.equal(result.status, "complete"); assert.equal(result.provider, "google-translate");
    assert(result.body.includes('<p t="123" d="456"><s ac="0">你好世界</s></p>'));
    assert(result.body.includes('<p t="999" d="1000">\n</p>'));
    assert.equal(google, 1);
    const mismatch = await (await caption.default.fetch(new Request(url.replace(encodeURIComponent(shared.fingerprint(xml)), "wrong")), env)).json();
    assert.equal(mismatch.status, "source-mismatch");
  } finally { global.fetch = oldFetch; }
});
test("caption sources reject foreign hosts, credentials, redirects and malformed XML", async () => {
  const {caption} = await ready;
  const env = {CAPTION_ACCESS_TOKEN: token, CAPTION_PREWARM: new Namespace(caption.CaptionPrewarm), CAPTION_QUEUE: {send: async () => {}}};
  for (const url of ["https://example.org/api/timedtext?v=abcdefghijk&lang=en", "http://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en", "https://user@www.youtube.com/api/timedtext?v=abcdefghijk&lang=en", "https://www.youtube.com/watch?v=abcdefghijk"]) {
    assert.equal((await caption.default.fetch(request("https://worker.test/caption/prewarm", {url, target: "zh-TW"}), env)).status, 400);
  }
  assert.throws(() => shared.parseCaptions("<html>challenge</html>"));
  assert.throws(() => shared.renderCaptions(xml, shared.parseCaptions(xml), []));
  const old = global.fetch; global.fetch = async (_, init) => { assert.equal(init.redirect, "manual"); return new Response("", {status: 302}); };
  try { await assert.rejects(shared.fetchDocument(sourceUrl)); } finally { global.fetch = old; }
});
test("a source supplied by the phone does not require a Cloudflare-origin YouTube fetch", async () => {
  const {caption} = await ready;
  const messages = [], env = {CAPTION_ACCESS_TOKEN: token, CAPTION_PREWARM: new Namespace(caption.CaptionPrewarm),
    CAPTION_JOBS: new Namespace(caption.CaptionJob), CAPTION_QUEUE: {send: async (body) => messages.push(body), sendBatch: async () => {}}};
  const oldFetch = global.fetch; global.fetch = () => { throw new Error("Cloudflare cannot fetch this source"); };
  try {
    const result = await caption.default.fetch(request("https://worker.test/caption/prewarm", {url: sourceUrl, body: xml, target: "zh-TW"}), env);
    assert.equal(result.status, 202);
    const item = message(messages[0]); await caption.default.queue({messages: [item]}, env);
    assert(item.acked); assert(!item.retried);
  } finally { global.fetch = oldFetch; }
});
test("prewarm enqueue is registered with waitUntil before a short-lived playback caller disconnects", async () => {
  const {caption} = await ready;
  const held = [], messages = [];
  const env = {CAPTION_ACCESS_TOKEN: token, CAPTION_PREWARM: new Namespace(caption.CaptionPrewarm), CAPTION_QUEUE: {send: async (body) => messages.push(body)}};
  const output = await caption.default.fetch(request("https://worker.test/caption/prewarm", {url: sourceUrl, body: xml, target: "zh-TW"}), env,
    {waitUntil: (work) => held.push(work)});
  assert.equal(output.status, 202); assert.equal(held.length, 1); await held[0]; assert.equal(messages.length, 1);
});
test("Music source prewarm populates the exact existing AI batch cache; foreground does not rerun AI", async () => {
  const {lyrics} = await ready;
  const messages = [], cache = new Map(); let runs = 0;
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: new Namespace(lyrics.LyricsPrewarm),
    LYRICS_QUEUE: {send: async (body) => messages.push(body)}, AI: {run: async () => { runs++; return {response: '["你好世界","晚安世界"]'}; }}};
  const oldFetch = global.fetch, oldCaches = global.caches;
  global.caches = {default: {match: async (req) => cache.get(req.url)?.clone(), put: async (req, res) => cache.set(req.url, res.clone())}};
  global.fetch = async (url, init) => {
    assert.equal(new URL(url).hostname, "music.youtube.com");
    assert.equal(init.headers.Authorization, undefined);
    return new URL(url).pathname.endsWith("/next") ? Response.json({tabs: [{browseEndpoint: {browseId: "MPLYt_test"}}]})
      : Response.json({musicDescriptionShelfRenderer: {description: {runs: [{text: "Hello world\nGoodnight world"}]}}});
  };
  try {
    const response = await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant"}), env, {});
    assert.equal(response.status, 202);
    const created = await response.json();
    await lyrics.default.queue({messages: [message(messages[0])]}, env, {});
    const status = await (await lyrics.default.fetch(new Request(`https://worker.test/lyrics/prewarm/${created.jobId}`, {headers: authorization}), env, {})).json();
    assert.equal(status.status, "processing", "source fetched is not equivalent to AI completed");
    const batch = messages.find((item) => item.jobId.startsWith("batch:")); assert(batch);
    await lyrics.default.queue({messages: [message(batch)]}, env, {});
    assert.equal(runs, 1);
    // Delete only this synthetic edge cache to verify durable reuse across data centers.
    cache.clear();
    const foreground = await lyrics.default.fetch(request("https://worker.test/lyrics", {texts: ["Hello world", "Goodnight world"], source: "auto", target: "zh-Hant"}), env, {});
    assert.equal(foreground.status, 200); assert.equal((await foreground.json()).provider, "cloudflare-ai");
    assert.equal(runs, 1);
    cache.clear();
    const regrouped = await lyrics.default.fetch(request("https://worker.test/lyrics", {
      texts: ["Goodnight world"], source: "auto", target: "zh-Hant", prewarmVideoId: "abcdefghijk",
    }), env, {});
    assert.equal(regrouped.status, 200);
    assert.deepEqual((await regrouped.json()).translations, ["晚安世界"]);
    assert.equal(runs, 1, "native/web batch boundaries must not force another AI translation");
  } finally { global.fetch = oldFetch; global.caches = oldCaches; }
});
test("invalid tokens cannot start prewarm; empty source lookups retry without running AI or caching a permanent absence", async () => {
  const {lyrics} = await ready; const messages = [];
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: new Namespace(lyrics.LyricsPrewarm), LYRICS_QUEUE: {send: async (body) => messages.push(body)}};
  assert.equal((await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant"}, {}), env, {})).status, 401);
  const oldFetch = global.fetch; global.fetch = async () => Response.json({tabs: []});
  try {
    const created = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant"}), env, {})).json();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const delivery = message(messages[0], attempt);
      await lyrics.default.queue({messages: [delivery]}, env, {});
      if (attempt < 5) assert.equal(delivery.retried.delaySeconds, Math.min(12, 3 * attempt));
      else assert(delivery.acked);
    }
    assert.equal((await (await lyrics.default.fetch(new Request(`https://worker.test/lyrics/prewarm/${created.jobId}`, {headers: authorization}), env, {})).json()).status, "unavailable");
    assert.equal(messages.length, 1);
    await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant"}), env, {});
    assert.equal(messages.length, 2, "a later playback can retry without waiting for the 24-hour DO expiry");
  } finally { global.fetch = oldFetch; }
});

test("a transient empty Music lookup recovers on redelivery and ignores legacy negative source caches", async () => {
  const {lyrics} = await ready, messages = [];
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: new Namespace(lyrics.LyricsPrewarm),
    LYRICS_QUEUE: {send: async (body) => messages.push(body)}};
  const oldId = await shared.identifier({version: 1, videoId: "abcdefghijk", target: "zh-TW", model: "@cf/qwen/qwen3-30b-a3b-fp8"});
  await shared.jobCall(env.LYRICS_PREWARM, oldId, "prepare", {work: {kind: "source"}});
  await shared.jobCall(env.LYRICS_PREWARM, oldId, "complete", {result: {available: false}});
  const oldFetch = global.fetch; let empty = true;
  global.fetch = async (url) => Response.json(empty ? {tabs: []} : String(url).includes("/next?")
    ? {browseEndpoint: {browseId: "MPLYrecovered"}}
    : {musicDescriptionShelfRenderer: {description: {runs: [{text: "Hello world"}]}}});
  try {
    const created = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant"}), env, {})).json();
    assert.notEqual(created.jobId, oldId);
    const first = message(messages[0]); await lyrics.default.queue({messages: [first]}, env, {});
    assert(first.retried); empty = false;
    await lyrics.default.queue({messages: [message(messages[0], 2)]}, env, {});
    const state = await shared.jobCall(env.LYRICS_PREWARM, created.jobId, "state");
    assert.equal(state.result.available, true); assert.equal(state.result.batchJobIds.length, 1);
  } finally { global.fetch = oldFetch; }
});

test("HTTP-edge lyric source acquisition survives a Queue origin that cannot retrieve lyrics", async () => {
  const {lyrics} = await ready, messages = [];
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: new Namespace(lyrics.LyricsPrewarm),
    LYRICS_QUEUE: {send: async (body) => messages.push(body)}};
  const oldFetch = global.fetch;
  global.fetch = async (url) => Response.json(String(url).includes("/next?")
    ? {browseEndpoint: {browseId: "MPLYedge"}}
    : {musicDescriptionShelfRenderer: {description: {runs: [{text: "Hello world\nGoodnight world"}]}}});
  try {
    const tasks = [];
    const created = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant"}), env,
      {waitUntil: (task) => tasks.push(task)})).json();
    assert(tasks.length); await Promise.all(tasks);
    global.fetch = async () => { throw new Error("Queue origin unavailable"); };
    await lyrics.default.queue({messages: [message(messages[0])]}, env, {});
    const state = await shared.jobCall(env.LYRICS_PREWARM, created.jobId, "state");
    assert.equal(state.result.available, true); assert.equal(state.result.batchJobIds.length, 1);
    const batch = await shared.jobCall(env.LYRICS_PREWARM, state.result.batchJobIds[0], "state");
    assert.deepEqual(batch.work.texts, ["Hello world", "Goodnight world"]);
  } finally { global.fetch = oldFetch; }
});

function bootstrap(options = {}) {
  const store = options.store || new Map(), calls = [], outputs = [];
  const context = {console: {log() {}}, setTimeout, clearTimeout, $argument: JSON.stringify({captionLang: "zh-Hant", captionToken: token,
    lyricsLang: "zh-Hant", lyricsToken: token, ...options.settings}),
    $persistentStore: {read: (key) => store.get(key), write: (value, key) => value ? store.set(key, value) : store.delete(key)},
    $httpClient: {post: (request, callback) => { calls.push(request); if (!options.hang) callback(null, {status: 202}, JSON.stringify({jobId: "b".repeat(64)})); }},
    $done: (output) => outputs.push(output)};
  vm.runInNewContext(fs.readFileSync(path.join(directory, "youtube.prewarm.client.js"), "utf8"), context);
  return {store, calls, outputs, context};
}
test("captions Off UI still prewarms the configured Enhance language; Music starts AI only with a token", async () => {
  const run = bootstrap();
  run.context.YouTubePrewarm.capture({captions: {renderer: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}}, true);
  const output = {body: "original player"}; run.context.$done(output);
  assert.equal(run.calls.length, 2); assert.equal(run.outputs[0], output);
  assert(run.calls.every((call) => !JSON.stringify(call).includes("Cookie")));
  const again = bootstrap({store: run.store});
  again.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, true);
  again.context.$done(output); assert.equal(again.calls.length, 0);
  const noAI = bootstrap({settings: {captionLang: "off", lyricsToken: "paste-token-here"}});
  noAI.context.YouTubePrewarm.capture({playbackTracking: {url: {baseUrl: "https://s.youtube.com/api/stats/watchtime?docid=abcdefghijk&x=1"}}}, true);
  noAI.context.$done(output); assert.equal(noAI.calls.length, 0);
});
test("hung prewarm submission releases the unchanged player within its 950ms cap; late callbacks cannot finish twice", async () => {
  const run = bootstrap({hang: true});
  run.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false);
  const started = Date.now(), output = {body: "play immediately"}; run.context.$done(output);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(run.outputs.length, 1); assert.equal(run.outputs[0], output); assert(Date.now() - started < 1300);
  run.context.$done({}); assert.equal(run.outputs.length, 1);
});
test("a fast local subtitle prefetch uploads only XML and never the YouTube account headers", async () => {
  const run = bootstrap();
  run.context.$request = {headers: {Authorization: "account-secret-must-not-leave", Cookie: "private-cookie", "User-Agent": "YouTube"}};
  run.context.$httpClient.get = (request, callback) => {
    assert.equal(request.headers.Authorization, undefined); assert.equal(request.headers.Cookie, undefined);
    assert(request.url.includes("fmt=srv3")); callback(null, {status: 200}, xml);
  };
  run.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false);
  run.context.$done({});
  assert.equal(JSON.parse(run.calls[0].body).body, xml);
  assert(!JSON.stringify(run.calls).includes("account-secret-must-not-leave"));
});
test("prewarm can be disabled and native target-language tracks need no translation", async () => {
  for (const settings of [{prewarm: false}, {captionLang: "en", lyricsLang: "off"}, {captionLang: "off", lyricsLang: "off"}]) {
    const run = bootstrap({settings}); run.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false);
    run.context.$done({}); assert.equal(run.calls.length, 0);
  }
});

function varint(value) {
  const bytes = [];
  do { let byte = value % 128; value = Math.floor(value / 128); if (value) byte |= 128; bytes.push(byte); } while (value);
  return Buffer.from(bytes);
}
function field(number, body) {
  const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
test("the real bundled player/get_watch handler triggers prewarm without a timedtext or get_panel request", async () => {
  const source = fs.readFileSync(path.join(directory, "youtube.response.js"), "utf8");
  const track = Buffer.concat([field(1, sourceUrl), field(4, "en")]);
  const player = Buffer.concat([field(10, field(51621377, field(1, track))), field(11, field(1, "abcdefghijk"))]);
  for (const endpoint of ["player", "get_watch"]) {
    const run = bootstrap();
    run.context.$request = {url: `https://youtubei.googleapis.com/youtubei/v1/${endpoint}`, headers: {"User-Agent": "com.google.ios.youtubemusic/8.0"}};
    run.context.$response = {body: Uint8Array.from(endpoint === "player" ? player : field(1, field(2, player)))};
    run.context.TextEncoder = TextEncoder; run.context.TextDecoder = TextDecoder;
    run.context.Uint8Array = Uint8Array; run.context.ArrayBuffer = ArrayBuffer;
    vm.runInNewContext(source, run.context);
    assert.equal(run.outputs.length, 1);
    assert.equal(run.calls.length, 2, endpoint);
    assert(run.calls.some((call) => call.url.includes("/lyrics/prewarm")));
    assert(run.calls.some((call) => call.url.includes("/caption/prewarm")));
  }
});
test("Music without captions can prewarm from the player's preserved video-details field", async () => {
  const source = fs.readFileSync(path.join(directory, "youtube.response.js"), "utf8");
  const run = bootstrap({settings: {captionLang: "off"}});
  run.context.$request = {url: "https://youtubei.googleapis.com/youtubei/v1/player", headers: {"User-Agent": "YouTubeMusic"}};
  run.context.$response = {body: Uint8Array.from(field(11, field(1, "abcdefghijk")))};
  Object.assign(run.context, {TextEncoder, TextDecoder, Uint8Array, ArrayBuffer});
  vm.runInNewContext(source, run.context);
  assert.equal(run.calls.length, 1);
  assert.equal(JSON.parse(run.calls[0].body).videoId, "abcdefghijk");
});
function captionClient(store, handler) {
  const timers = new Set(), calls = [];
  let finish;
  const output = new Promise((resolve) => { finish = resolve; });
  const context = {console: {log() {}}, encodeURIComponent, decodeURIComponent,
    setTimeout(callback, delay) { const id = setTimeout(() => { timers.delete(id); callback(); }, delay); timers.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    $request: {url: `${sourceUrl}&enhance_tlang=zh-TW`}, $response: {status: 200, body: xml, headers: {}},
    $argument: JSON.stringify({captionToken: token}), $persistentStore: {read: (key) => store.get(key), write: (value, key) => store.set(key, value)},
    $httpClient: Object.fromEntries(["get", "post"].map((method) => [method, (request, callback) => {
      calls.push({method, request, at: Date.now()}); handler(method, request, callback);
    }])),
    $done(result) { for (const id of timers) clearTimeout(id); timers.clear(); finish(result); }};
  vm.runInNewContext(fs.readFileSync(path.join(directory, "youtube.caption.js"), "utf8"), context);
  return {output, calls};
}
test("a completed document is returned directly; its lookup never postpones the normal immediate-CC job", async () => {
  await ready;
  const boot = bootstrap(); boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); boot.context.$done({});
  const translated = shared.renderCaptions(xml, shared.parseCaptions(xml), ["快取譯文"]);
  const run = captionClient(boot.store, (method, request, callback) => {
    if (request.url.includes("/prewarm/")) {
      setTimeout(() => callback(null, {status: 200}, JSON.stringify({status: "complete", sourceHash: shared.fingerprint(xml), target: "zh-TW", provider: "google-translate", body: translated})), 15);
    } else if (method === "post") callback(null, {status: 202}, JSON.stringify({jobId: "0".repeat(8)+"-0000-0000-0000-"+"0".repeat(12), pollAfterMs: 500}));
  });
  const result = await run.output;
  assert.equal(result.body, translated);
  const lookup = run.calls.find((call) => call.request.url.includes("/prewarm/"));
  const submitted = run.calls.find((call) => call.method === "post");
  assert(submitted.at - lookup.at < 10, "a prewarm lookup must not hold the old foreground path");
  assert.equal(run.calls.filter((call) => !call.request.url.includes("workers.dev")).length, 0);
});
test("a changed-source/unfinished prewarm retains the original Google queue path and response budget", async () => {
  const boot = bootstrap(); boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); boot.context.$done({});
  const started = Date.now();
  const run = captionClient(boot.store, (method, request, callback) => {
    if (request.url.includes("/prewarm/")) callback(null, {status: 200}, JSON.stringify({status: "source-mismatch"}));
    else if (method === "post") callback(null, {status: 202}, JSON.stringify({jobId: "0".repeat(8)+"-0000-0000-0000-"+"0".repeat(12), pollAfterMs: 250}));
    else callback(null, {status: 200}, JSON.stringify({status: "complete", translations: ["即時譯文"]}));
  });
  const result = await run.output;
  assert(result.body.includes("即時譯文")); assert(Date.now() - started < 1500);
});
test("an immediate lyric request and a concurrently delivered prewarm batch invoke AI only once", async () => {
  const {lyrics} = await ready;
  let release, started; const begun = new Promise((resolve) => { started = resolve; });
  const messages = [], env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: new Namespace(lyrics.LyricsPrewarm),
    LYRICS_QUEUE: {send: async (body) => messages.push(body)}, AI: {run: async () => { started(); return new Promise((resolve) => { release = () => resolve({response: '["唯一譯文"]'}); }); }}};
  const oldCaches = global.caches; global.caches = undefined;
  try {
    const foreground = lyrics.default.fetch(request("https://worker.test/lyrics", {texts: ["Unique foreground line"], source: "auto", target: "zh-Hant"}), env, {waitUntil() {}});
    await begun;
    const duplicate = message(messages[0]);
    await lyrics.default.queue({messages: [duplicate]}, env, {});
    assert(duplicate.retried, "the duplicate must wait for the durable lease");
    release(); assert.equal((await foreground).status, 200);
    const later = message(messages[0]); await lyrics.default.queue({messages: [later]}, env, {});
    assert(later.acked);
  } finally { global.caches = oldCaches; }
});
test("coordination and durable persistence failures cannot discard a valid foreground AI result", async () => {
  const {lyrics} = await ready;
  const oldCaches = global.caches; global.caches = undefined;
  try {
    for (const mode of ["unavailable", "complete-fails", "invalid-provider"]) {
      const namespace = new Namespace(lyrics.LyricsPrewarm);
      const line = "Storage recovery test "+mode;
      if (mode === "invalid-provider") {
        const target = lyrics.__test.normalizeLanguage("zh-Hant", false);
        const key = await lyrics.__test.cacheRequest([line], "auto", target);
        await shared.jobCall(namespace, `batch:${key.identifier}`, "prepare", {work: {}});
        await shared.jobCall(namespace, `batch:${key.identifier}`, "complete", {result: {provider: "google-translate", translations: ["舊谷歌快取"]}});
      }
      const failing = {idFromName: (name) => name, get(id) {
        const original = namespace.get(id);
        return {fetch(url, init) {
          if (mode === "unavailable" || (mode === "complete-fails" && new URL(url).pathname === "/complete")) throw new Error("Synthetic storage failure");
          return original.fetch(url, init);
        }};
      }};
      const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: failing, LYRICS_QUEUE: {send: async () => {}},
        AI: {run: async () => ({response: '["安全譯文"]'})}};
      const result = await lyrics.default.fetch(request("https://worker.test/lyrics", {
        texts: [line], source: "auto", target: "zh-Hant",
      }), env, {});
      assert.equal(result.status, 200, mode); assert.equal((await result.json()).provider, "cloudflare-ai");
    }
  } finally { global.caches = oldCaches; }
});
