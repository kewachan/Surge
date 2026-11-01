const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const {test, before} = require("node:test");
let worker;
const token = "a".repeat(64);
const videoId = "abcdefghijk";
const sourceUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&sig=synthetic`;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, "youtube.worker.js"), "utf8");
  worker = await import(`data:text/javascript;base64,${Buffer.from("const console = {error() {}};\n" + source).toString("base64")}`);
});
function vi(value) {
  const bytes = [];
  do { let byte = value % 128; value = Math.floor(value / 128); if (value) byte |= 128; bytes.push(byte); } while (value);
  return Buffer.from(bytes);
}
const field = (number, body) => Buffer.concat([vi(number * 8 + 2), vi(Buffer.byteLength(body)), Buffer.from(body)]);
const scalar = (number, value) => Buffer.concat([vi(number * 8), vi(value)]);
function ump(type, body) {
  assert(body.length < 0x4000);
  const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x80 | body.length % 64, Math.floor(body.length / 64)]);
  return Buffer.concat([Buffer.from([type]), length, body]);
}
function fixture({captions = false, ad = true, nextOnly = false, unicode = false} = {}) {
  const key = Buffer.alloc(32, 7), iv = Buffer.alloc(16, 3);
  const track = Buffer.concat([field(1, sourceUrl + (unicode ? "&name=ไทย" : "")), field(4, "en")]);
  const player = Buffer.concat([field(11, field(1, videoId)),
    ...(captions ? [field(10, field(51621377, field(1, track)))] : []),
    ...(ad ? [field(7, "advertisement")] : []), field(198, "unknown-field-kept")]);
  const clear = field(4, Buffer.concat([field(nextOnly ? 3 : 2, player), scalar(7, 0), scalar(10, 0)]));
  const cipher = crypto.createCipheriv("aes-128-ctr", key.subarray(0, 16), iv);
  const encrypted = Buffer.concat([cipher.update(zlib.gzipSync(clear)), cipher.final()]);
  const hmac = crypto.createHmac("sha256", key.subarray(16)).update(Buffer.concat([encrypted, iv])).digest();
  const metadata = Buffer.concat([ump(10, scalar(1, 25)), ump(11, Buffer.concat([
    field(1, encrypted), field(2, hmac), field(3, iv), scalar(4, 1)]))]);
  return {key, metadata, input: Buffer.concat([metadata, ump(21, Buffer.from("audio-unchanged"))])};
}
async function transform(metadata, key, prewarm = true, target = "zh-Hant") {
  return worker.default.fetch(new Request(`https://init.test/transform?ck=${encodeURIComponent(key.toString("base64"))}&captionLang=${target}${prewarm ? "&prewarm=1" : ""}`,
    {method: "POST", headers: {"Content-Type": "application/vnd.yt-ump"}, body: metadata}));
}
function hint(response) {
  const encoded = response.headers.get("x-youtube-player-prewarm");
  return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null;
}
async function client(input, key, options = {}) {
  const calls = [], store = new Map([["YouTubePlaybackKeys.v2.youtubeMusic", JSON.stringify({entries: [
    {clientKey: key.toString("base64"), expiresAt: Date.now() + 60000}]})]]);
  const logs = [], timers = new Set(); let count = 0, resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const settings = {captionLang: "zh-Hant", lyricsLang: "zh-Hant", captionToken: token, lyricsToken: token, prewarm: true, ...options.settings};
  const context = {TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Int32Array,
    console: {log: (text) => logs.push(text)}, $argument: JSON.stringify(settings),
    $request: {url: "https://rr1.googlevideo.com/initplayback?c=IOS_MUSIC&ack=1", headers: {
      "User-Agent": "com.google.ios.youtubemusic/9.43.2", Authorization: "private-account-header", Cookie: "private-cookie"}},
    $response: {status: 200, headers: {"Content-Type": "application/vnd.yt-ump"}, body: new Uint8Array(input)},
    $persistentStore: {read: (name) => store.get(name), write: (value, name) => store.set(name, value)},
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    $httpClient: {
      get(request, callback) { calls.push(request); callback(null, {status: 200}, ""); },
      post(request, callback) {
        calls.push(request);
        if (request.url.includes("/transform?")) {
          transform(request.body, key, new URL(request.url).searchParams.get("prewarm") === "1", settings.captionLang).then(async (response) => {
            const headers = Object.fromEntries(response.headers);
            if (options.badHint) headers["x-youtube-player-prewarm"] = "not-valid-json";
            if (options.expired) context.YouTubePrewarm.deadline = Date.now() - 1;
            callback(null, {status: response.status, headers}, new Uint8Array(await response.arrayBuffer()));
          }).catch(reject);
        } else callback(null, {status: 202}, JSON.stringify({jobId: "b".repeat(64)}));
      }
    },
    $done(output) { count++; resolve(output); }
  };
  const source = fs.readFileSync(path.join(__dirname, "youtube.init.response.js"), "utf8");
  vm.runInNewContext(source, context, {filename: "youtube.init.response.js"});
  let guard;
  try {
    const output = await Promise.race([result, new Promise((_, no) => { guard = setTimeout(() => no(Error("Native test timed out")), 1800); })]);
    assert.equal(count, 1);
    return {output, calls, store, logs};
  } finally { clearTimeout(guard); for (const timer of timers) clearTimeout(timer); }
}
test("encrypted-only Music exposes authenticated current-player metadata only when requested", async () => {
  const f = fixture({captions: true, unicode: true});
  assert.equal(hint(await transform(f.metadata, f.key, false)), null);
  const result = hint(await transform(f.metadata, f.key));
  assert.equal(result.videoId, videoId); assert.equal(result.captions.captionTracks.length, 1);
  assert(result.captions.captionTracks[0].baseUrl.includes("%E0"));
  assert.deepEqual(Object.keys(result).sort(), ["captions", "videoId"]);
  const invalid = await transform(f.metadata, Buffer.alloc(32, 9));
  assert.equal(hint(invalid), null, "unverified encrypted metadata cannot trigger work");
  const next = fixture({nextOnly: true, ad: false});
  assert.equal(hint(await transform(next.metadata, next.key)), null, "NextResponse must not masquerade as the playing video");
});
test("no ad changes are required to expose a valid playback prewarm hint", async () => {
  const f = fixture({ad: false}), response = await transform(f.metadata, f.key, true, "off");
  assert.equal(hint(response).videoId, videoId);
  assert(Buffer.from(await response.arrayBuffer()).equals(f.metadata));
});
test("native encrypted startup queues lyrics before get_panel, including songs without captions", async () => {
  const f = fixture(), run = await client(f.input, f.key);
  const submitted = run.calls.filter((call) => call.url.endsWith("/lyrics/prewarm"));
  assert.equal(submitted.length, 1); assert.equal(JSON.parse(submitted[0].body).videoId, videoId);
  assert.equal(JSON.parse(run.store.get("YouTubeLyrics.Prewarm.Active.v1")).videoId, videoId);
  assert(!JSON.stringify(run.calls).includes("private-account-header"));
  assert(!JSON.stringify(run.calls).includes("private-cookie"));
  const output = worker.__test.parseUmp(new Uint8Array(run.output.body));
  assert.equal(Buffer.from(output.at(-1).data).toString(), "audio-unchanged");
});
test("native encrypted long-video startup queues original captions and lyrics with the configured targets", async () => {
  const f = fixture({captions: true}), run = await client(f.input, f.key);
  const caption = run.calls.find((call) => call.url.endsWith("/caption/prewarm"));
  assert(caption); assert.equal(JSON.parse(caption.body).target, "zh-TW");
  assert.equal(JSON.parse(caption.body).url, sourceUrl);
  assert(run.calls.some((call) => call.url.endsWith("/lyrics/prewarm")));
});
test("disabled prewarm, malformed hints and an exhausted playback deadline keep playback intact without jobs", async () => {
  const f = fixture({captions: true});
  for (const options of [{settings: {prewarm: false}}, {badHint: true}, {expired: true}]) {
    const run = await client(f.input, f.key, options);
    assert(run.output.body); assert.equal(run.calls.filter((call) => /\/(?:caption|lyrics)\/prewarm$/.test(call.url)).length, 0);
    if (options.settings) assert(!run.calls[0].url.includes("prewarm=1"));
    assert.equal(Buffer.from(worker.__test.parseUmp(new Uint8Array(run.output.body)).at(-1).data).toString(), "audio-unchanged");
  }
});
test("module passes prewarm languages, tokens and the switch to the encrypted Music response handler", () => {
  const line = fs.readFileSync(path.join(__dirname, "YouTube.Enhance.sgmodule"), "utf8").split("\n").find((line) => line.startsWith("youtube.init_playback.response ="));
  for (const setting of ["captionLang", "captionToken", "lyricsLang", "lyricsToken", "prewarm"]) assert(line.includes(`"${setting}"`));
  assert(line.includes("youtube.init.response.js?v=20261101-3"));
});
test("private HAR encrypted-only startup replay submits the missing jobs before the lyric/caption panels", {skip: !process.env.PREWARM_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.PREWARM_HAR_PATH, "utf8")).log.entries;
  let songs = 0, captions = 0;
  for (const entry of entries) {
    const url = new URL(entry.request.url);
    if (url.hostname !== "youtube-init.hmtw47cv7m.workers.dev" || url.pathname !== "/transform" || entry.response?.status !== 200) continue;
    const post = entry.request.postData;
    const metadata = Buffer.from(post.text, post.encoding === "base64" ? "base64" : "utf8");
    const key = Buffer.from(url.searchParams.get("ck"), "base64");
    const expected = hint(await transform(metadata, key));
    assert(expected && /^[\w-]{11}$/.test(expected.videoId));
    const run = await client(Buffer.concat([metadata, ump(21, Buffer.from("audio-unchanged"))]), key);
    const lyric = run.calls.find((call) => call.url.endsWith("/lyrics/prewarm"));
    assert(lyric); assert(JSON.parse(lyric.body).videoId === expected.videoId, "current song must be used"); songs++;
    if (expected.captions.captionTracks.length) {
      const caption = run.calls.find((call) => call.url.endsWith("/caption/prewarm"));
      assert(caption); assert(JSON.parse(caption.body).url === expected.captions.captionTracks[0].baseUrl, "current original caption source must be used"); captions++;
    }
    assert(!run.logs.some((text) => /failed|unsupported|timeout/.test(text)));
  }
  assert(songs > 0, "HAR must contain an encrypted-only startup");
  assert(captions > 0, "HAR must contain a long-caption startup");
});
