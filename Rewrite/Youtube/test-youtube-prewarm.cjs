const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const {run: nativeRun} = require("../../Tools/Testing/surge-harness.cjs");
require("./test-youtube-lyrics-model.cjs");
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
    .replace(/^import \{[^\n]+\} from "\.\/youtube\.chinese\.js";$/m,
      fs.readFileSync(path.join(directory, "youtube.chinese.js"), "utf8").replace(/^export /gm, ""))
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
test("device lyric source skips the state preflight and acknowledges only a durable Queue submission", async () => {
  const {lyrics} = await ready, actions = [], messages = [], held = [];
  const namespace = new Namespace(lyrics.LyricsPrewarm), originalGet = namespace.get.bind(namespace);
  namespace.get = (id) => ({fetch: (url, init) => {
    actions.push(new URL(url instanceof Request ? url.url : url).pathname);
    return originalGet(id).fetch(url, init);
  }});
  let release, entered, finished = false;
  const queueEntered = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: namespace,
    LYRICS_QUEUE: {send: async (body) => { entered(); await gate; messages.push(body); }}};
  const payload = {videoId: "abcdefghijk", target: "zh-Hant", sourceLines: ["Hello world"]};
  const oldFetch = global.fetch;
  global.fetch = () => { throw Error("device source must not fetch YouTube"); };
  try {
    const pending = lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", payload), env,
      {waitUntil: (work) => held.push(work)}).then((response) => { finished = true; return response; });
    await queueEntered;
    assert.deepEqual(actions, ["/prepare"], "no redundant state RPC on cold playback");
    assert.equal(finished, false, "202 must not precede Queue.send acknowledgement");
    release();
    const response = await pending, created = await response.json();
    assert.equal(response.status, 202); assert.equal(created.reused, false); assert.equal(messages.length, 1);
    assert.deepEqual((await shared.jobCall(namespace, created.jobId, "state")).work.sourceLines, payload.sourceLines);
    const duplicate = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", payload), env,
      {waitUntil: (work) => held.push(work)})).json();
    assert.equal(duplicate.jobId, created.jobId); assert.equal(duplicate.reused, true); assert.equal(messages.length, 1);
    await Promise.all(held);
  } finally { release(); global.fetch = oldFetch; }
});
test("failed device-source Queue submissions stay retryable and never return a successful acknowledgement", async () => {
  const {lyrics} = await ready, messages = [];
  let fail = true;
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: new Namespace(lyrics.LyricsPrewarm),
    LYRICS_QUEUE: {send: async (body) => { if (fail) throw Error("synthetic Queue outage"); messages.push(body); }}};
  const payload = {videoId: "abcdefghijk", target: "zh-Hant", sourceLines: ["Hello world"]};
  assert.equal((await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", payload), env)).status, 500);
  fail = false;
  const response = await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", payload), env);
  assert.equal(response.status, 202); assert.equal((await response.json()).reused, false); assert.equal(messages.length, 1);
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
  const store = options.store || new Map(), calls = [], outputs = [], backgroundOutputs = [], apiCalls = [], logs = [];
  const context = {console: {log(text) { logs.push(text); }}, setTimeout, clearTimeout, $argument: JSON.stringify({captionLang: "zh-Hant", captionToken: token,
    lyricsLang: "zh-Hant", lyricsToken: token, ...options.settings}),
    $persistentStore: {read: (key) => store.get(key) ?? null, write: (value, key) => {value === null ? store.delete(key) : store.set(key, value); return true;}},
    $request: {headers: {}},
    $httpClient: {post: (request, callback) => {
      if (request.url.startsWith("https://music.youtube.com/")) { callback(null, {status: 200}, "{}"); return; }
      calls.push(request); if (options.fail) callback("timeout"); else if (!options.hang) callback(null, {status: 202}, JSON.stringify({jobId: "b".repeat(64)}));
    }},
    $done: (output) => outputs.push(output)};
  const source = fs.readFileSync(path.join(directory, "youtube.prewarm.client.js"), "utf8");
  context.$httpAPI = (method, endpoint, body, callback) => {
    apiCalls.push({method, endpoint, body});
    if (options.noKick) return;
    const timers = new Set();
    const child = {...context, $request: options.requestStub ? {headers: {}} : undefined, $response: undefined,
      setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timers.add(timer); return timer; },
      clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
      $done: (output) => { for (const timer of timers) clearTimeout(timer); backgroundOutputs.push(output); callback({}); }};
    delete child.$argument;
    if (options.noClearTimeout) delete child.clearTimeout;
    vm.runInNewContext(body.script_text, child);
  };
  vm.runInNewContext(source, context);
  return {store, calls, outputs, backgroundOutputs, apiCalls, logs, context};
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
test("hung background submission cannot hold playback or complete the player twice", async () => {
  const run = bootstrap({hang: true});
  run.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false);
  const started = Date.now(), output = {body: "play immediately"}; run.context.$done(output);
  assert.equal(run.outputs.length, 1); assert.equal(run.outputs[0], output); assert(Date.now() - started < 100);
  run.context.$done({}); assert.equal(run.outputs.length, 1);
});

const pendingKey = "YouTubeTranslation.PrewarmPending.v1", leaseKey = "YouTubeTranslation.PrewarmLease.v1";
const backgroundArgs = {captionLang: "off", lyricsLang: "zh-Hant", lyricsToken: token, prewarm: true};
function queuedLyrics(options = {}) {
  const boot = bootstrap({noKick: true, settings: backgroundArgs, ...options});
  boot.context.YouTubePrewarm.capture({videoId: "abcdefghijk"}, true);
  const output = {body: "unchanged audio"}; boot.context.$done(output);
  assert.equal(boot.outputs[0], output); assert.equal(boot.calls.length, 0);
  return boot;
}
function runBackground(store, options = {}) {
  return nativeRun("Rewrite/Youtube/youtube.prewarm.client.js", {store, now: Date.now(),
    globals: {$request: undefined}, argument: JSON.stringify(backgroundArgs), ...options});
}
test("one-shot background work retains credential-free jobs and accepts a delayed ACK without blocking playback", async () => {
  const boot = queuedLyrics();
  assert.equal(boot.apiCalls.length, 1); assert.equal(boot.apiCalls[0].endpoint, "v1/scripting/evaluate");
  assert.equal(boot.apiCalls[0].body.mock_type, "generic"); assert.equal(boot.apiCalls[0].body.timeout, 8);
  assert.equal(typeof boot.apiCalls[0].body.script_text, "string");
  assert(!boot.store.get(pendingKey).includes(token));
  const background = await runBackground(boot.store, {http: (_method, req) => {
    if (req.url.includes("/next?")) return {delay: 200, body: '{"browseEndpoint":{"browseId":"MPLYtest"}}'};
    if (req.url.includes("/browse?")) return {delay: 200, body: '{"musicDescriptionShelfRenderer":{"description":{"simpleText":"Device verse"}}}'};
    assert.equal(req.timeout, 3); assert.equal(JSON.parse(req.body).sourceLines[0], "Device verse");
    return {delay: 1200, status: 202, body: JSON.stringify({jobId: "b".repeat(64)})};
  }});
  assert.equal(background.elapsed, 1600, "background must accept an ACK beyond the former 900ms limit");
  assert.equal(background.done.length, 1);
  assert.equal(JSON.parse(boot.store.get("YouTubeLyrics.Prewarm.v1.abcdefghijk.zh-Hant")).confirmed, true);
  assert(!boot.store.has(pendingKey)); assert(!boot.store.has(leaseKey));
});
test("repeated playback packets deduplicate kicks while a new song and bounded retry remain immediate", () => {
  const store = new Map(); let calls = 0;
  function play(videoId) {
    const boot = bootstrap({noKick: true, store, settings: backgroundArgs});
    boot.context.YouTubePrewarm.capture({videoId}, true); boot.context.$done({body: "audio"});
    calls += boot.apiCalls.length;
    assert.equal(boot.outputs[0].body, "audio");
  }
  for (let i = 0; i < 50; i++) play("abcdefghijk");
  assert.equal(calls, 1, "one pending song must not start 50 background evaluations");
  play("abcdefghijl"); assert.equal(calls, 2, "new work bypasses retry cooldown");
  store.set("YouTubeTranslation.PrewarmKick.v1", JSON.stringify({savedAt: Date.now() - 60001}));
  play("abcdefghijl"); assert.equal(calls, 3, "a lost kick stays retryable after one minute");
  store.set("YouTubeTranslation.PrewarmKick.v1", "invalid JSON");
  play("abcdefghijm"); assert.equal(calls, 4, "damaged throttle metadata cannot disable a new song");
});
test("expired failed producer attempts retry once across repeated playback packets", () => {
  const store = new Map(), kickKey = "YouTubeTranslation.PrewarmKick.v1";
  function play(videoId = "abcdefghijk") {
    const run = bootstrap({store, noKick: true, settings: backgroundArgs});
    run.context.YouTubePrewarm.capture({videoId}, true); run.context.$done({body: "audio"});
    assert.equal(run.outputs[0].body, "audio");
    assert.equal(run.calls.length, 0, "foreground playback must not submit translation requests");
    return run.apiCalls.length;
  }
  assert.equal(play(), 1);
  const key = "YouTubeLyrics.Prewarm.v1.abcdefghijk.zh-Hant";
  store.set(key, JSON.stringify({savedAt: Date.now() - 20000, confirmed: false}));
  let retries = 0;
  for (let i = 0; i < 50; i++) retries += play();
  assert.equal(retries, 1, "one expired failed attempt must not force fifty evaluations");
  store.set(key, JSON.stringify({savedAt: Date.now() - 16000, confirmed: false}));
  assert.equal(play(), 1, "a distinct expired producer attempt remains immediately retryable");
  assert.equal(play(), 0);
  const kick = JSON.parse(store.get(kickKey));
  store.set(kickKey, JSON.stringify({...kick, savedAt: Date.now() - 60001}));
  assert.equal(play(), 1, "a missed recovery launch remains retryable after the cooldown");
  assert.equal(play("abcdefghijl"), 1, "new songs still bypass the cooldown");
  assert([...store.values()].every(value => !String(value).includes(token)));
});
test("an idle response cannot run queued work and the module has no automatic prewarm schedule", () => {
  const boot = queuedLyrics();
  const idle = bootstrap({store: boot.store, settings: backgroundArgs});
  idle.context.$done({body: "unrelated response"});
  assert.equal(idle.apiCalls.length, 0); assert.equal(idle.calls.length, 0);
  assert.equal(idle.outputs[0].body, "unrelated response"); assert(boot.store.has(pendingKey));
  const module = fs.readFileSync(path.join(directory, "YouTube.Enhance.sgmodule"), "utf8");
  assert(!/\b(?:cronexp|wake-system)=/.test(module));
  assert(!module.includes("youtube.prewarm.background ="));
});
test("a later playback event retries a missed kick without a timer or persistent credentials", () => {
  const boot = queuedLyrics();
  boot.store.set("YouTubeTranslation.PrewarmKick.v1", JSON.stringify({savedAt: Date.now() - 60001}));
  const again = bootstrap({store: boot.store, settings: backgroundArgs});
  again.context.YouTubePrewarm.capture({videoId: "abcdefghijk"}, true); again.context.$done({body: "audio"});
  assert.equal(again.apiCalls.length, 1); assert.equal(again.backgroundOutputs.length, 1);
  assert.equal(again.outputs[0].body, "audio"); assert(!boot.store.has(pendingKey));
  assert([...boot.store.values()].every(value => !String(value).includes(token)), "no token or generated script is persisted");
});
test("self-contained generic evaluation supports an empty request stub without clearTimeout or inherited arguments", () => {
  const boot = bootstrap({noClearTimeout: true, requestStub: true, settings: {lyricsLang: "off"}});
  boot.context.$httpClient.get = (_request, callback) => callback(null, {status: 200}, xml);
  boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false);
  boot.context.$done({body: "player"});
  assert.equal(boot.outputs[0].body, "player"); assert.equal(boot.backgroundOutputs.length, 1);
  assert.equal(boot.calls.length, 1); assert.equal(JSON.parse(boot.calls[0].body).body, xml);
});
test("background failures retain work, active leases prevent duplicates, and disabling prewarm clears pending work", async () => {
  const boot = queuedLyrics(), started = Date.now();
  boot.store.set(leaseKey, JSON.stringify({owner: "other", until: started + 7000}));
  const blocked = await runBackground(boot.store, {now: started});
  assert.equal(blocked.requests.length, 0); assert(boot.store.has(pendingKey));
  boot.store.delete(leaseKey);
  const failure = await runBackground(boot.store, {http: (_method, req) => req.url.includes("workers.dev")
    ? {error: "timeout"} : {body: "{}"}});
  assert.equal(failure.requests.length, 2); assert(boot.store.has(pendingKey)); assert(!boot.store.has(leaseKey));
  assert.equal(failure.apiCalls.length, 0, "failed snapshot jobs must not create an invocation loop");
  const disabled = await runBackground(boot.store, {argument: JSON.stringify({...backgroundArgs, prewarm: false})});
  assert.equal(disabled.requests.length, 0); assert(!boot.store.has(pendingKey));
  const empty = await runBackground(boot.store);
  assert.equal(empty.requests.length, 0); assert.equal(empty.writes.length, 0);
});
test("an accepted background job cannot delete newly queued work and storage errors cannot stall the player", async () => {
  const boot = queuedLyrics(); let newId;
  const running = await runBackground(boot.store, {http: (_method, req) => {
    if (!req.url.includes("workers.dev")) return {body: "{}"};
    const pending = JSON.parse(boot.store.get(pendingKey));
    const next = {...pending[0], id: "new-generation", key: "YouTubeLyrics.Prewarm.v1.abcdefghijl.ja",
      payload: {videoId: "abcdefghijl", target: "ja"}};
    newId = next.id; boot.store.set(pendingKey, JSON.stringify([...pending, next]));
    return {status: 202, body: JSON.stringify({jobId: "b".repeat(64)})};
  }});
  assert.deepEqual(JSON.parse(boot.store.get(pendingKey)).map(plan => plan.id), [newId]);
  assert.equal(running.apiCalls.length, 1, "new work arriving during an active lease gets a follow-up kick");
  const oldArguments = await runBackground(boot.store);
  assert.equal(oldArguments.requests.length, 0);
  assert.equal(JSON.parse(boot.store.get(pendingKey))[0].payload.target, "ja", "old arguments must not discard a newly selected language");
  const fail = bootstrap({noKick: true, settings: backgroundArgs});
  fail.context.$persistentStore.write = () => false;
  fail.context.YouTubePrewarm.capture({videoId: "abcdefghijk"}, true); fail.context.$done({body: "audio"});
  assert.equal(fail.outputs[0].body, "audio"); assert.equal(fail.apiCalls.length, 0); assert.equal(fail.calls.length, 0);
});
test("pending work is bounded and stale or malformed records cannot cause background requests", async () => {
  const store = new Map();
  for (let index = 0; index < 12; index++) {
    const boot = bootstrap({noKick: true, store, settings: backgroundArgs});
    boot.context.YouTubePrewarm.capture({videoId: `abcdefghij${index.toString(16)}`}, true);
    boot.context.$done({});
  }
  const pending = JSON.parse(store.get(pendingKey)); assert.equal(pending.length, 8);
  assert(pending.every(item => !Object.hasOwn(item, "token")));
  const base = Date.now();
  store.set(pendingKey, JSON.stringify([
    {...pending[0], queuedAt: base - 1200001}, {...pending[0], queuedAt: base + 10000},
    {...pending[0], kind: "unknown"}, {...pending[0], key: "private-setting"}]));
  const invalid = await runBackground(store, {now: base});
  assert.equal(invalid.requests.length, 0); assert(!store.has(pendingKey));
  store.set("private-setting", "keep"); store.set(pendingKey, "invalid JSON");
  const malformed = await runBackground(store);
  assert.equal(malformed.requests.length, 0); assert.equal(store.get("private-setting"), "keep");
});
test("private pwfail sources queue independently of audio and accept delayed Worker ACKs", {skip: !process.env.PREWARM_FAILURE_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.PREWARM_FAILURE_HAR_PATH, "utf8")).log.entries;
  const decode = data => data.encoding === "base64" ? Buffer.from(data.text, "base64").toString("utf8") : data.text;
  let songs = 0, supplied = 0, empty = 0;
  for (const entry of entries) {
    const url = new URL(entry.request.url);
    if (url.hostname !== "youtube-lyrics-translate.hmtw47cv7m.workers.dev" || url.pathname !== "/lyrics/prewarm") continue;
    const payload = JSON.parse(decode(entry.request.postData));
    const sources = entries.filter(item => new URL(item.request.url).hostname === "music.youtube.com");
    const next = sources.find(item => new URL(item.request.url).pathname.endsWith("/next")
      && JSON.parse(decode(item.request.postData)).videoId === payload.videoId);
    const browse = sources.find(item => new URL(item.request.url).pathname.endsWith("/browse")
      && JSON.parse(decode(item.request.postData)).browseId === payload.browseId);
    assert(next && browse, "fixture must include the phone's public source requests");
    const boot = bootstrap({noKick: true, settings: backgroundArgs});
    boot.context.YouTubePrewarm.capture({videoId: payload.videoId}, true);
    boot.context.$done({body: "audio"});
    assert.equal(boot.outputs[0].body, "audio"); assert.equal(boot.calls.length, 0);
    const result = await runBackground(boot.store, {http: (_method, req) => {
      if (req.url.includes("workers.dev")) {
        const submitted = JSON.parse(req.body);
        assert.equal(submitted.browseId, payload.browseId);
        assert.equal(submitted.sourceLines?.length || 0, payload.sourceLines?.length || 0);
        if (submitted.sourceLines?.length) supplied++; else empty++;
        return {delay: 1200, status: 202, body: JSON.stringify({jobId: "b".repeat(64)})};
      }
      assert.equal(req.headers.Authorization, undefined); assert.equal(req.headers.Cookie, undefined);
      const source = req.url.includes("/next?") ? next : browse;
      return {delay: Math.round(source.time), status: source.response.status, body: decode(source.response.content)};
    }});
    assert.equal(result.done.length, 1); assert(!boot.store.has(pendingKey));
    assert.equal(JSON.parse(boot.store.get(`YouTubeLyrics.Prewarm.v1.${payload.videoId}.zh-Hant`)).confirmed, true);
    songs++;
  }
  assert.equal(songs, 6); assert.equal(supplied, 4); assert.equal(empty, 2);
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

test("a lost prewarm acknowledgement retains the exact content-addressed caption job, including Unicode XML", async () => {
  await ready;
  for (const body of [undefined, xml.replace("Hello &amp; world", "泰文 ไทย 😀 &amp; 中文")]) {
    const run = bootstrap({fail: true, settings: {lyricsLang: "off", debug: true}});
    if (body) run.context.$httpClient.get = (_, callback) => callback(null, {status: 200}, body);
    run.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false);
    run.context.$done({});
    const record = [...run.store].find(([key]) => key.startsWith("YouTubeCaption.Prewarm."));
    const saved = JSON.parse(record[1]);
    const payload = JSON.parse(run.calls[0].body);
    assert.equal(payload.body, body);
    const source = shared.captionSource(payload.url);
    assert.equal(saved.jobId, await shared.identifier({version: 1, track: source.track, target: payload.target, body: payload.body}));
    assert.equal(saved.confirmed, false);
    assert(run.logs.some((line) => line.includes("submitted-unconfirmed")));
    assert(!run.logs.some((line) => line.includes("unavailable")));
  }
});

test("a mature unacknowledged caption prewarm returns full XML with one lookup and no resubmission", async () => {
  await ready;
  const boot = bootstrap({fail: true, settings: {lyricsLang: "off"}});
  boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); boot.context.$done({});
  for (const [key, value] of boot.store) if (key.startsWith("YouTubeCaption.Prewarm.")) {
    boot.store.set(key, JSON.stringify({...JSON.parse(value), savedAt: Date.now() - 20000}));
  }
  const body = shared.renderCaptions(xml, shared.parseCaptions(xml), ["已完成譯文"]);
  const run = captionClient(boot.store, (_, request, callback) => {
    assert(request.url.includes("/prewarm/"));
    callback(null, {status: 200}, JSON.stringify({status: "complete", sourceFetched: true,
      sourceHash: shared.fingerprint(xml), target: "zh-TW", provider: "google-translate", body}));
  });
  assert.equal((await run.output).body, body); assert.equal(run.calls.length, 1);
  let sourceReads = 0;
  const again = bootstrap({fail: true, store: boot.store, settings: {lyricsLang: "off"}});
  again.context.$httpClient.get = (_, callback) => { sourceReads++; callback(null, {status: 200}, xml); };
  again.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); again.context.$done({});
  assert.equal(sourceReads, 0, "verified Worker source retrieval should skip the next speculative phone download");
  assert.equal(JSON.parse(again.calls[0].body).body, undefined);
});

test("a stalled mature lookup is bounded and keeps immediate fallback available", async () => {
  const boot = bootstrap({fail: true, settings: {lyricsLang: "off"}});
  boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); boot.context.$done({});
  for (const [key, value] of boot.store) if (key.startsWith("YouTubeCaption.Prewarm."))
    boot.store.set(key, JSON.stringify({...JSON.parse(value), savedAt: Date.now() - 20000}));
  const start = Date.now();
  const run = captionClient(boot.store, (method, request, callback) => {
    if (request.url.includes("/prewarm/")) return;
    if (method === "post") callback(null, {status: 202}, JSON.stringify({jobId: "00000000-0000-0000-0000-000000000000", reused: true}));
    else callback(null, {status: 200}, JSON.stringify({status: "complete", translations: ["後備譯文"]}));
  });
  assert((await run.output).body.includes("後備譯文"));
  assert(Date.now() - start >= 2400); assert(Date.now() - start < 3400);
});

test("a local source-routing preference write failure cannot discard completed captions", async () => {
  const boot = bootstrap({fail: true, settings: {lyricsLang: "off"}});
  boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); boot.context.$done({});
  for (const [key, value] of boot.store) if (key.startsWith("YouTubeCaption.Prewarm."))
    boot.store.set(key, JSON.stringify({...JSON.parse(value), savedAt: Date.now() - 20000}));
  const originalSet = boot.store.set.bind(boot.store);
  boot.store.set = (key, value) => { if (key.startsWith("YouTubeCaption.SourceRoute.")) throw new Error("Preferences unavailable"); return originalSet(key, value); };
  const body = shared.renderCaptions(xml, shared.parseCaptions(xml), ["安全譯文"]);
  const run = captionClient(boot.store, (_, request, callback) => {
    assert(request.url.includes("/prewarm/"));
    callback(null, {status: 200}, JSON.stringify({status: "complete", sourceFetched: true, sourceHash: shared.fingerprint(xml),
      target: "zh-TW", provider: "google-translate", body}));
  });
  assert.equal((await run.output).body, body); assert.equal(run.calls.length, 1);
});

test("Worker origin failures restore phone prefetch", async () => {
  const boot = bootstrap({fail: true, settings: {lyricsLang: "off"}});
  boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); boot.context.$done({});
  for (const [key, value] of boot.store) if (key.startsWith("YouTubeCaption.Prewarm."))
    boot.store.set(key, JSON.stringify({...JSON.parse(value), savedAt: Date.now() - 20000}));
  const routeKey = `YouTubeCaption.SourceRoute.v1.${shared.fingerprint(JSON.stringify(["", "", "asr"]))}`;
  boot.store.set(routeKey, JSON.stringify({workerUntil: Date.now() + 60000}));
  const run = captionClient(boot.store, (method, request, callback) => {
    if (request.url.includes("/prewarm/")) callback(null, {status: 200}, JSON.stringify({status: "failed", code: "source-http-429"}));
    else if (method === "post") callback(null, {status: 202}, JSON.stringify({jobId: "00000000-0000-0000-0000-000000000000", reused: true}));
    else callback(null, {status: 200}, JSON.stringify({status: "complete", translations: ["新來源譯文"]}));
  });
  assert((await run.output).body.includes("新來源譯文")); assert(!boot.store.get(routeKey));
  let sourceReads = 0;
  const again = bootstrap({fail: true, store: boot.store, settings: {lyricsLang: "off"}});
  again.context.$httpClient.get = (_, callback) => { sourceReads++; callback(null, {status: 200}, xml); };
  again.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); again.context.$done({});
  assert.equal(sourceReads, 1);
});

test("mature prewarm lookup rejects a completed document with a different source fingerprint", async () => {
  const boot = bootstrap({fail: true, settings: {lyricsLang: "off"}});
  boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); boot.context.$done({});
  for (const [key, value] of boot.store) if (key.startsWith("YouTubeCaption.Prewarm."))
    boot.store.set(key, JSON.stringify({...JSON.parse(value), savedAt: Date.now() - 20000}));
  const run = captionClient(boot.store, (method, request, callback) => {
    if (request.url.includes("/prewarm/")) callback(null, {status: 200}, JSON.stringify({status: "complete", sourceHash: "old-source", target: "zh-TW", provider: "google-translate", body: "<timedtext>stale</timedtext>"}));
    else if (method === "post") callback(null, {status: 202}, JSON.stringify({jobId: "00000000-0000-0000-0000-000000000000", reused: true}));
    else callback(null, {status: 200}, JSON.stringify({status: "complete", translations: ["正確時間軸"]}));
  });
  const result = await run.output; assert(result.body.includes("正確時間軸")); assert(result.body.includes('t="123" d="456"'));
});

async function seededSong(lyrics, count = 34) {
  const namespace = new Namespace(lyrics.LyricsPrewarm), target = "zh-TW";
  const texts = Array.from({length: count}, (_, i) => `Whole song line ${i}`);
  const translations = texts.map((_, i) => `整首譯文${i}`);
  const id = await shared.identifier({version: 2, videoId: "abcdefghijk", target, model: "@cf/qwen/qwen3.8-27b"});
  const ids = [];
  for (let i = 0; i < count; i += 12) {
    const key = await lyrics.__test.cacheRequest(texts.slice(i, i + 12), "auto", target), child = `batch:${key.identifier}`;
    ids.push(child); await shared.jobCall(namespace, child, "prepare", {work: {}});
    await shared.jobCall(namespace, child, "complete", {result: {sourceTexts: texts.slice(i, i + 12), translations: translations.slice(i, i + 12), provider: "cloudflare-ai"}});
  }
  await shared.jobCall(namespace, id, "prepare", {work: {}});
  await shared.jobCall(namespace, id, "complete", {result: {available: true, batchJobIds: ids}});
  return {namespace, id, ids, texts, translations};
}

test("whole-song cache-only lookup merges once and persists the bundle across edge-cache misses", async () => {
  const {lyrics} = await ready, song = await seededSong(lyrics);
  const oldCaches = global.caches, oldFetch = global.fetch; global.caches = undefined;
  global.fetch = async () => { throw new Error("Cache-only route cannot retrieve sources"); };
  let childReads = 0;
  const namespace = {idFromName: (id) => id, get(id) { const stub = song.namespace.get(id); return {fetch(url, init) {
    if (id.startsWith("batch:") && new URL(url).pathname === "/state") childReads++;
    return stub.fetch(url, init);
  }}; }};
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: namespace,
    LYRICS_QUEUE: {send() { throw new Error("Completed prewarm must not enqueue AI again"); }},
    AI: {run() { throw new Error("Cache-only route cannot run AI"); }}};
  try {
    const tasks = [];
    const accepted = await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant"}), env,
      {waitUntil: (task) => tasks.push(task)});
    assert.equal(accepted.status, 202); await Promise.all(tasks);
    assert((await shared.jobCall(song.namespace, song.id, "state")).result.body, "completed prewarm should prepare the bundle before the lyrics panel opens");
    const payload = {videoId: "abcdefghijk", target: "zh-Hant", texts: song.texts};
    const first = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm/result", payload), env, {})).json();
    assert.equal(first.status, "complete"); assert.deepEqual(first.translations, song.translations); assert.equal(childReads, 3);
    childReads = 0;
    const second = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm/result", payload), env, {})).json();
    assert.deepEqual(second.translations, song.translations); assert.equal(childReads, 0);
    const normal = await lyrics.default.fetch(request("https://worker.test/lyrics", {...payload, source: "auto"}), env, {});
    assert.equal(normal.status, 400, "34-line cache reads must not enlarge the 12-line AI limit");
  } finally { global.caches = oldCaches; global.fetch = oldFetch; }
});

test("partial song caches never accept Google results, wrong targets or unknown lines as completed AI", async () => {
  const {lyrics} = await ready, song = await seededSong(lyrics, 13);
  const oldCaches = global.caches; global.caches = undefined;
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: song.namespace};
  await shared.jobCall(song.namespace, song.ids[1], "complete", {result: {sourceTexts: song.texts.slice(12), translations: ["谷歌"], provider: "google-translate"}});
  try {
    const result = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm/result", {videoId: "abcdefghijk", target: "zh-Hant", texts: [...song.texts, "Unknown verse"]}), env, {})).json();
    assert.equal(result.status, "partial"); assert.equal(result.translations[12], null); assert.equal(result.translations[13], null);
    assert(result.translations.slice(0, 12).every(Boolean));
    const wrong = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm/result", {videoId: "abcdefghijk", target: "ja", texts: song.texts}), env, {})).json();
    assert.equal(wrong.status, "pending");
    assert.equal((await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm/result", {videoId: "abcdefghijk", target: "zh-Hant", texts: song.texts}, {}), env, {})).status, 401);
  } finally { global.caches = oldCaches; }
});

test("a large merged song bundle uses chunked durable storage below the per-value limit", async () => {
  const {lyrics} = await ready, song = await seededSong(lyrics);
  for (let index = 0; index < song.ids.length; index++) {
    const sourceTexts = song.texts.slice(index * 12, index * 12 + 12);
    await shared.jobCall(song.namespace, song.ids[index], "complete", {result: {sourceTexts,
      translations: sourceTexts.map(() => "譯".repeat(2000)), provider: "cloudflare-ai"}});
  }
  const oldCaches = global.caches; global.caches = undefined;
  try {
    const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: song.namespace};
    const result = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm/result", {videoId: "abcdefghijk", target: "zh-Hant", texts: song.texts}), env, {})).json();
    assert.equal(result.status, "complete");
    const stored = await song.namespace.objects.get(song.id).ctx.storage.get("state");
    assert(stored.result.bodyRef.count > 1);
    const again = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm/result", {videoId: "abcdefghijk", target: "zh-Hant", texts: song.texts}), env, {})).json();
    assert.equal(again.translations[33].length, 2000);
  } finally { global.caches = oldCaches; }
});

test("phone lyric-source prefetch supplies public lines without account headers and survives a missing Worker acknowledgement", async () => {
  const run = bootstrap({settings: {captionLang: "off", debug: true}}), calls = [];
  run.context.$request.headers = {Authorization: "private-account-secret", Cookie: "private-cookie"};
  run.context.$httpClient.post = (request, callback) => {
    calls.push(request);
    if (request.url.startsWith("https://music.youtube.com/")) {
      assert.equal(request.headers.Authorization, undefined); assert.equal(request.headers.Cookie, undefined);
      assert(request.timeout > 0 && request.timeout <= 0.85);
      const document = request.url.includes("/next?") ? {tabs: [{browseEndpoint: {browseId: "MPLYvalid"}}]}
        : {musicDescriptionShelfRenderer: {description: {runs: [{text: "First verse\nSecond verse\nFirst verse"}]}}};
      callback(null, {status: 200}, JSON.stringify(document));
    } else callback("HTTP request timeout");
  };
  run.context.YouTubePrewarm.capture({videoId: "abcdefghijk"}, true); run.context.$done({body: "play"});
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[2].body).sourceLines, ["First verse", "Second verse"]);
  assert(run.logs.includes("YouTube lyrics prewarm: source: device"));
  assert(run.logs.includes("YouTube lyrics prewarm: submitted-unconfirmed"));
  assert.equal(run.outputs.length, 1);
  assert(!JSON.stringify(calls).includes("private-account-secret"));
});

test("slow or malformed public lyric sources retain URL-only background work within the playback deadline", async () => {
  for (const mode of ["hung", "invalid-endpoint", "oversized-line"]) {
    const run = bootstrap({settings: {captionLang: "off"}}), submissions = [];
    run.context.$httpClient.post = (request, callback) => {
      if (request.url.startsWith("https://music.youtube.com/")) {
        if (mode === "hung") return;
        if (mode === "invalid-endpoint") callback(null, {status: 200}, JSON.stringify({browseEndpoint: {browseId: "https://foreign.test/private"}}));
        else callback(null, {status: 200}, JSON.stringify(request.url.includes("/next?") ? {browseEndpoint: {browseId: "MPLYvalid"}}
          : {musicDescriptionShelfRenderer: {description: {simpleText: "x".repeat(501)}}}));
      } else { submissions.push(request); callback(null, {status: 202}, JSON.stringify({jobId: "b".repeat(64)})); }
    };
    const start = Date.now(); run.context.YouTubePrewarm.capture({videoId: "abcdefghijk"}, true); run.context.$done({});
    if (mode === "hung") await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(submissions.length, 1, mode); assert.equal(JSON.parse(submissions[0].body).sourceLines, undefined);
    assert.equal(run.outputs.length, 1); assert(Date.now() - start < 1000);
  }
});

test("a supplied phone source prewarms AI even when the Worker cannot acquire public lyrics", async () => {
  const {lyrics} = await ready, oldFetch = global.fetch, oldCaches = global.caches;
  global.fetch = async () => { throw new Error("Worker source cannot be retrieved"); }; global.caches = undefined;
  const messages = [], namespace = new Namespace(lyrics.LyricsPrewarm);
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: namespace, LYRICS_QUEUE: {send: async (body) => messages.push(body)},
    AI: {run: async (_, params) => {
      const lines = JSON.parse(params.messages[1].content.match(/Target lines JSON: (.*)/)[1]);
      return {response: JSON.stringify({translations: lines.map(() => "已預熱譯文")})};
    }}};
  const sourceLines = Array.from({length: 23}, (_, index) => "Phone lyric " + index);
  try {
    const response = await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant", sourceLines}), env, {});
    assert.equal(response.status, 202);
    for (let index = 0; index < messages.length; index++) await lyrics.default.queue({messages: [message(messages[index])]}, env, {});
    const result = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm/result", {videoId: "abcdefghijk", target: "zh-Hant", texts: sourceLines}), env, {})).json();
    assert.equal(result.status, "complete"); assert.equal(result.translations.length, 23);
    assert(result.translations.every((line) => line === "已預熱譯文"));
    for (const source of [[], [null], ["x".repeat(501)], Array(385).fill("verse")])
      assert.equal((await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant", sourceLines: source}), env, {})).status, 400);
    assert.equal((await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant", sourceLines: Array(50).fill("x".repeat(400))}), env, {})).status, 413);
  } finally { global.fetch = oldFetch; global.caches = oldCaches; }
});

test("device source upgrades queued acquisition without losing the existing delivery or overwriting processing work", async () => {
  await ready;
  const namespace = new Namespace(shared.PrewarmJob), messages = [], id = "e".repeat(64);
  const queue = {send: async (message) => messages.push(message)};
  const work = {kind: "source", videoId: "abcdefghijk", target: "zh-TW"};
  await shared.enqueue(namespace, queue, id, work);
  await shared.enqueue(namespace, queue, id, {...work, sourceLines: ["Device verse"]});
  assert.equal(messages.length, 1);
  const claimed = await shared.jobCall(namespace, id, "run", {});
  assert.deepEqual(claimed.work.sourceLines, ["Device verse"]);
  await shared.enqueue(namespace, queue, id, {...work, sourceLines: ["Later verse"]});
  assert.deepEqual((await shared.jobCall(namespace, id, "state")).work.sourceLines, ["Device verse"]);
});

test("non-thinking prompts retain exact target/script guards and include full context only when distinct", async () => {
  const {lyrics} = await ready, requests = [];
  const texts = ["เธอคือความหวัง", "原有繁體標點！"];
  const env = {AI: {run: async (_, params) => { requests.push(params); return {response: '{"translations":["你是希望","原有繁體標點！"]}'}; }}};
  await lyrics.__test.translateLyrics(texts, "auto", "zh-TW", env);
  let prompt = requests[0].messages[1].content;
  assert.deepEqual(requests[0].chat_template_kwargs, {enable_thinking: false});
  assert(prompt.includes("Traditional Chinese")); assert(prompt.includes("你或你的") || prompt.includes("你 or 你的"));
  assert(prompt.includes("byte-for-byte")); assert(!prompt.includes("Full lyric context JSON:"));
  assert.equal(prompt.split(JSON.stringify(texts)).length - 1, 1);
  assert.equal(requests[0].response_format.type, "json_schema"); assert.equal(requests[0].max_tokens, 1024);
  await lyrics.__test.translateLyrics(texts, "auto", "zh-TW", env, [...texts, "Other context"]);
  prompt = requests[1].messages[1].content;
  assert(prompt.includes("Full lyric context JSON:"));
  assert.deepEqual(requests[1].chat_template_kwargs, {enable_thinking: false});
  const neutral = await lyrics.__test.translateLyrics(["เธอคือความหวัง"], "auto", "zh-TW", {
    AI: {run: async () => ({response: '{"translations":["妳是希望"]}'})},
  });
  assert.equal(neutral.translations[0], "你是希望");
});

test("completed caption documents cache by job and original fingerprint; cache failures retain the validated result", async () => {
  const {caption} = await ready, oldFetch = global.fetch, oldCaches = global.caches;
  const cached = new Map(), messages = [];
  const env = {CAPTION_ACCESS_TOKEN: token, CAPTION_PREWARM: new Namespace(caption.CaptionPrewarm), CAPTION_JOBS: new Namespace(caption.CaptionJob),
    CAPTION_QUEUE: {send: async (body) => messages.push(body), sendBatch: async (batch) => messages.push(...batch.map((item) => item.body))}};
  global.caches = {default: {match: async (key) => cached.get(key.url)?.clone(), put: async (key, value) => { cached.set(key.url, value.clone()); }}};
  global.fetch = async (url) => new URL(url).hostname === "www.youtube.com" ? new Response(xml) : Response.json(["預先完成"]);
  try {
    const created = await (await caption.default.fetch(request("https://worker.test/caption/prewarm", {url: sourceUrl, target: "zh-TW"}), env, {})).json();
    for (let index = 0; index < messages.length; index++) await caption.default.queue({messages: [message(messages[index])]}, env);
    const url = `https://worker.test/caption/prewarm/${created.jobId}?sourceHash=${encodeURIComponent(shared.fingerprint(xml))}`;
    const first = await (await caption.default.fetch(new Request(url), env, {})).json();
    assert.equal(first.status, "complete"); assert.equal(cached.size, 1);
    const original = env.CAPTION_PREWARM;
    env.CAPTION_PREWARM = {idFromName() { throw new Error("A cache hit must not reload original XML"); }};
    const hit = await (await caption.default.fetch(new Request(url), env, {})).json(); assert.equal(hit.body, first.body);
    env.CAPTION_PREWARM = original;
    const mismatch = await (await caption.default.fetch(new Request(url.replace(/sourceHash=.*/, "sourceHash=changed")), env, {})).json();
    assert.equal(mismatch.status, "source-mismatch"); assert(!mismatch.body);
    global.caches.default.match = async () => { throw new Error("Cache unavailable"); };
    global.caches.default.put = async () => { throw new Error("Cache unavailable"); };
    assert.equal((await (await caption.default.fetch(new Request(url), env, {})).json()).body, first.body);
  } finally { global.fetch = oldFetch; global.caches = oldCaches; }
});

test("an already-warm caption taking 1.8 seconds returns directly inside the unchanged response budget", async () => {
  const boot = bootstrap({fail: true, settings: {lyricsLang: "off"}});
  boot.context.YouTubePrewarm.capture({captions: {captionTracks: [{baseUrl: sourceUrl, languageCode: "en"}]}}, false); boot.context.$done({});
  for (const [key, value] of boot.store) if (key.startsWith("YouTubeCaption.Prewarm."))
    boot.store.set(key, JSON.stringify({...JSON.parse(value), savedAt: Date.now() - 20000}));
  const result = shared.renderCaptions(xml, shared.parseCaptions(xml), ["手機速度仍能命中"]), start = Date.now();
  const run = captionClient(boot.store, (_, request, callback) => {
    assert(request.url.includes("/prewarm/"));
    setTimeout(() => callback(null, {status: 200}, JSON.stringify({status: "complete", provider: "google-translate", target: "zh-TW", sourceHash: shared.fingerprint(xml), body: result})), 1800);
  });
  assert.equal((await run.output).body, result); assert.equal(run.calls.length, 1);
  assert(Date.now() - start >= 1750 && Date.now() - start < 2600);
});

test("a 780ms device source fits the existing playback deadline instead of losing the second RPC at 700ms", async () => {
  const run = bootstrap({settings: {captionLang: "off"}}), submissions = [];
  run.context.$httpClient.post = (request, callback) => {
    if (request.url.includes("/next?")) setTimeout(() => callback(null, {status: 200}, '{"browseEndpoint":{"browseId":"MPLYslow"}}'), 430);
    else if (request.url.includes("/browse?")) setTimeout(() => callback(null, {status: 200}, '{"musicDescriptionShelfRenderer":{"description":{"simpleText":"Device verse"}}}'), 350);
    else { submissions.push(JSON.parse(request.body)); callback(null, {status: 202}, JSON.stringify({jobId: "b".repeat(64)})); }
  };
  const start = Date.now(); run.context.YouTubePrewarm.capture({videoId: "abcdefghijk"}, true); run.context.$done({});
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.deepEqual(submissions[0].sourceLines, ["Device verse"]); assert.equal(submissions[0].browseId, "MPLYslow");
  assert.equal(run.outputs.length, 1); assert(Date.now() - start < 1050);
});

test("a stalled device browse preserves its validated MPLY hint for background retrieval, ignoring late callbacks", async () => {
  const run = bootstrap({settings: {captionLang: "off"}}), submissions = []; let late;
  run.context.$httpClient.post = (request, callback) => {
    if (request.url.includes("/next?")) callback(null, {status: 200}, '{"browseEndpoint":{"browseId":"MPLYfallback"}}');
    else if (request.url.includes("/browse?")) late = callback;
    else { submissions.push(JSON.parse(request.body)); callback(null, {status: 202}, JSON.stringify({jobId: "b".repeat(64)})); }
  };
  run.context.YouTubePrewarm.capture({videoId: "abcdefghijk"}, true); run.context.$done({});
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(submissions.length, 1); assert.equal(submissions[0].sourceLines, undefined); assert.equal(submissions[0].browseId, "MPLYfallback");
  late(null, {status: 200}, '{"musicDescriptionShelfRenderer":{"description":{"simpleText":"Too late"}}}');
  assert.equal(submissions.length, 1); assert.equal(run.outputs.length, 1);
});

test("a validated device browse hint bypasses an empty Worker next response and is retained for Queue retries", async () => {
  const {lyrics} = await ready, oldFetch = global.fetch, namespace = new Namespace(lyrics.LyricsPrewarm), messages = [], calls = [];
  const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: namespace, LYRICS_QUEUE: {send: async (body) => messages.push(body)}};
  global.fetch = async (url, init) => {
    calls.push(new URL(url).pathname); assert(new URL(url).pathname.endsWith("/browse"));
    assert.equal(JSON.parse(init.body).browseId, "MPLYfromDevice");
    return Response.json({musicDescriptionShelfRenderer: {description: {simpleText: "Background verse"}}});
  };
  try {
    const response = await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant", browseId: "MPLYfromDevice"}), env, {});
    assert.equal(response.status, 202); assert.equal(calls.length, 1);
    const id = (await response.json()).jobId, state = await shared.jobCall(namespace, id, "state");
    assert.equal(state.work.browseId, "MPLYfromDevice"); assert.deepEqual(state.work.sourceLines, ["Background verse"]);
    for (const browseId of ["https://foreign.test/path", "MPLY", "MPLYx?cookie=secret", null])
      assert.equal((await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant", browseId}), env, {})).status, 400);
    const queuedId = "f".repeat(64), work = {kind: "source", videoId: "abcdefghijk", target: "zh-TW", sourceLines: ["Keep source"]};
    await shared.enqueue(namespace, env.LYRICS_QUEUE, queuedId, work);
    await shared.enqueue(namespace, env.LYRICS_QUEUE, queuedId, {kind: "source", videoId: "abcdefghijk", target: "zh-TW", browseId: "MPLYfromDevice"});
    const upgraded = await shared.jobCall(namespace, queuedId, "state"); assert.deepEqual(upgraded.work.sourceLines, ["Keep source"]); assert.equal(upgraded.work.browseId, "MPLYfromDevice");
  } finally { global.fetch = oldFetch; }
});

test("private Pw3 lost-browse replay still submits the known lyric endpoint without waiting for the source body", {skip: !process.env.PW3_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.PW3_HAR_PATH, "utf8")).log.entries;
  const failedBrowse = entries.find((e) => e.request?.url.startsWith("https://music.youtube.com/youtubei/v1/browse") && !e.response);
  assert(failedBrowse, "Pw3 must contain the device browse timeout");
  const browseId = JSON.parse(failedBrowse.request.postData.text).browseId;
  const next = entries.find((e) => e.request?.url.startsWith("https://music.youtube.com/youtubei/v1/next") && e.response?.content?.text?.includes(browseId));
  assert(next); const videoId = JSON.parse(next.request.postData.text).videoId;
  const run = bootstrap({settings: {captionLang: "off"}}), submitted = [];
  run.context.$httpClient.post = (request, callback) => {
    if (request.url.includes("/next?")) callback(null, {status: 200}, next.response.content.text);
    else if (request.url.includes("/browse?")) return;
    else { submitted.push(JSON.parse(request.body)); callback("HTTP request timeout"); }
  };
  run.context.YouTubePrewarm.capture({videoId}, true); run.context.$done({});
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(submitted.length, 1); assert.equal(submitted[0].browseId, browseId); assert.equal(submitted[0].videoId, videoId);
  assert.equal(run.outputs.length, 1);
});

test("Chinese prewarm source schedules no AI, while mixed songs schedule only their foreign lines", async () => {
  const {lyrics} = await ready, oldFetch = global.fetch, oldCaches = global.caches;
  global.fetch = async () => { throw new Error("Supplied source must not need retrieval"); }; global.caches = undefined;
  try {
    for (const mixed of [false, true]) {
      const messages = [], namespace = new Namespace(lyrics.LyricsPrewarm); let aiCalls = 0;
      const sourceLines = ["我爱你", "让我们重新开始", ...(mixed ? ["Stay with me"] : [])];
      const env = {LYRICS_ACCESS_TOKEN: token, LYRICS_PREWARM: namespace, LYRICS_QUEUE: {send: async (body) => messages.push(body)},
        AI: {run: async (_, params) => {
          aiCalls++; assert.deepEqual(JSON.parse(params.messages[1].content.match(/Target lines JSON: (.*)/)[1]), ["Stay with me"]);
          return {response: '{"translations":["陪在我身邊"]}'};
        }}};
      const created = await (await lyrics.default.fetch(request("https://worker.test/lyrics/prewarm", {videoId: "abcdefghijk", target: "zh-Hant", sourceLines}), env, {})).json();
      for (let index = 0; index < messages.length; index++) await lyrics.default.queue({messages: [message(messages[index])]}, env, {});
      const status = await (await lyrics.default.fetch(new Request("https://worker.test/lyrics/prewarm/" + created.jobId, {headers: authorization}), env, {})).json();
      assert.equal(status.status, "complete"); assert.equal(status.localConversion, true);
      assert.equal(aiCalls, mixed ? 1 : 0); assert.equal(status.batchCount, mixed ? 1 : 0); assert.equal(messages.length, mixed ? 2 : 1);
    }
  } finally { global.fetch = oldFetch; global.caches = oldCaches; }
});
