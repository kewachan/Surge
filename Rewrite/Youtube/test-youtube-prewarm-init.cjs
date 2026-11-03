const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const {test, before} = require("node:test");
const {run: runSurge} = require("../../Tools/Testing/surge-harness.cjs");
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
  assert(body.length < 0x200000);
  const length = body.length < 128 ? Buffer.from([body.length]) : body.length < 0x4000
    ? Buffer.from([0x80 | body.length % 64, Math.floor(body.length / 64)])
    : Buffer.from([0xc0 | body.length % 32, Math.floor(body.length / 32) % 256, Math.floor(body.length / 8192)]);
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
  const calls = [], store = options.store || new Map([["YouTubePlaybackKeys.v2.youtubeMusic", JSON.stringify({entries: [
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
  context.$httpAPI = (_method, _path, body, callback) => {
    if (options.noKick) return;
    const child = {...context, $request: undefined, $response: undefined, $done() { callback({}); }};
    delete child.$argument;
    vm.runInNewContext(body.script_text, child);
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

const musicKeys = "YouTubePlaybackKeys.v2.youtubeMusic";
function configFixture(key, ttl = 259200) {
  return field(1, field(16, field(7, field(138536474, field(146311580,
    Buffer.concat([field(1, key), field(2, Buffer.alloc(128, 9)), scalar(3, ttl)]))))));
}
async function captureConfig(store, key, options = {}) {
  return runSurge("Rewrite/Youtube/youtube.response.js", {
    store, now: options.now ?? Date.now(), argument: '{"prewarm":false}',
    request: {url: "https://youtubei.googleapis.com/youtubei/v1/log_event", headers: {
      "User-Agent": options.userAgent || "com.google.ios.youtubemusic/9.43.2"}},
    response: {status: 200, headers: {"Content-Type": "application/x-protobuf"}, body: new Uint8Array(configFixture(key, options.ttl))},
    globals: options.globals,
  });
}
test("Music key rotation retains the key for an in-flight startup without replacing the current config", async () => {
  const f = fixture(), nextKey = Buffer.alloc(32, 8), store = new Map(), now = Date.now();
  await captureConfig(store, f.key, {now});
  await captureConfig(store, nextKey, {now: now + 3000});
  assert.equal(JSON.parse(store.get("YouTubeConfig")).youtubeMusic.clientKey, nextKey.toString("base64"));
  const run = await client(f.input, f.key, {store, settings: {prewarm: false}});
  assert(run.output.body, "the older in-flight metadata must still be filtered");
  assert.equal(new URL(run.calls.find(call => call.url.includes("/transform?")).url).searchParams.get("ck"), f.key.toString("base64"));
  assert.equal(Buffer.from(worker.__test.parseUmp(run.output.body).at(-1).data).toString(), "audio-unchanged");
  assert(!run.logs.some(line => /failed|refresh requested/.test(line)));
});
test("Music key history expires, deduplicates and keeps at most eight recent keys", async () => {
  const store = new Map(), now = Date.now();
  for (let i = 1; i <= 10; i++) await captureConfig(store, Buffer.alloc(32, i), {now: now + i * 1000});
  await captureConfig(store, Buffer.alloc(32, 10), {now: now + 11000});
  let entries = JSON.parse(store.get(musicKeys)).entries;
  assert.equal(entries.length, 8);
  assert.equal(entries[0].clientKey, Buffer.alloc(32, 10).toString("base64"));
  assert.equal(new Set(entries.map(entry => entry.clientKey)).size, 8);
  assert.equal(entries[0].expiresAt, now + 611000, "history lasts at most ten minutes, despite a three-day server key");
  await captureConfig(store, Buffer.alloc(32, 11), {now: now + 612000, ttl: 60});
  entries = JSON.parse(store.get(musicKeys)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].expiresAt, now + 672000, "a shorter upstream lifetime is respected");
});
test("Music key history handles malformed storage and cannot interrupt normal config capture", async () => {
  const key = Buffer.alloc(32, 7);
  for (const saved of ["{", "null", "[]", '{"entries":[null,{"expiresAt":"later"}]}']) {
    const store = new Map([[musicKeys, saved]]), run = await captureConfig(store, key);
    assert.equal(run.done.length, 1);
    assert.equal(JSON.parse(store.get(musicKeys)).entries.length, 1);
    assert.equal(JSON.parse(store.get("YouTubeConfig")).youtubeMusic.clientKey, key.toString("base64"));
  }
  const store = new Map(), run = await captureConfig(store, key, {globals: {$persistentStore: {
    read: name => store.get(name) || null,
    write(value, name) { if (name === musicKeys) throw new Error("Synthetic history write failure"); store.set(name, value); return true; },
  }}});
  assert.equal(run.done.length, 1);
  assert.deepEqual(Object.keys(run.done[0]), [], "config responses remain untouched even if history storage fails");
  assert.equal(JSON.parse(store.get("YouTubeConfig")).youtubeMusic.clientKey, key.toString("base64"));
});
test("Music key history ignores invalid keys, expired lifetimes and ordinary YouTube config", async () => {
  for (const options of [{ttl: 0}, {userAgent: "com.google.ios.youtube/21"}]) {
    const store = new Map(); await captureConfig(store, Buffer.alloc(32, 7), options);
    assert(!store.has(musicKeys));
  }
  const store = new Map(); await captureConfig(store, Buffer.alloc(31, 7));
  assert(!store.has(musicKeys));
});
test("an unknown Music key preserves playback and requests a later config refresh", async () => {
  const f = fixture(), store = new Map();
  await captureConfig(store, Buffer.alloc(32, 8));
  const run = await client(f.input, f.key, {store, settings: {prewarm: false}});
  assert.deepEqual(Object.keys(run.output), []);
  assert.equal(run.calls.length, 0);
  assert.equal(JSON.parse(store.get(musicKeys)).refreshNeeded, true);
});
test("private Music key-rotation HAR filters the previously missed first startup and preserves all media", {skip: !process.env.MUSIC_KEY_ROTATION_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.MUSIC_KEY_ROTATION_HAR_PATH, "utf8")).log.entries;
  const endTime = entry => Date.parse(entry.startedDateTime) + entry.time;
  const decode = body => Buffer.from(body.text, body.encoding === "base64" ? "base64" : "utf8");
  const first = entries.filter(entry => {
    const url = new URL(entry.request.url);
    return url.hostname.endsWith(".googlevideo.com") && url.pathname === "/initplayback" &&
      url.searchParams.get("c") === "IOS_MUSIC" && entry.request.method === "POST" && entry.response?.status === 200;
  }).sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime))[0];
  assert(first, "capture must include a native Music startup");
  const store = new Map(), versions = [];
  for (const entry of entries.filter(entry => /\/youtubei\/v1\/(?:log_event|config)(?:\?|$)/.test(entry.request.url) &&
    entry.response?.status === 200 && entry.response.content?.text && endTime(entry) < endTime(first)).sort((a, b) => endTime(a) - endTime(b))) {
    await runSurge("Rewrite/Youtube/youtube.response.js", {store, now: Date.now(), argument: '{"prewarm":false}',
      request: {url: entry.request.url, headers: Object.fromEntries(entry.request.headers.map(header => [header.name, header.value]))},
      response: {status: 200, headers: {}, body: new Uint8Array(decode(entry.response.content))}});
    const value = JSON.parse(store.get("YouTubeConfig") || "{}").youtubeMusic?.clientKey;
    if (value && !versions.includes(value)) versions.push(value);
  }
  assert(versions.length >= 2, "two captured configs must finish before the initial startup returns");
  const input = decode(first.response.content), before = worker.__test.parseUmp(input);
  let encrypted = false, signatureFields;
  for (const part of before) {
    if (part.type === 10) encrypted = worker.__test.parseProto(part.data).find(field => field.no === 1 && field.wire === 0)?.value.value === 25;
    else if (part.type === 11 && encrypted) { signatureFields = worker.__test.parseProto(part.data); break; }
  }
  assert(signatureFields);
  const get = number => signatureFields.find(field => field.no === number && field.wire === 2)?.value;
  const matches = value => crypto.timingSafeEqual(Buffer.from(get(2)), crypto.createHmac("sha256", Buffer.from(value, "base64").subarray(16))
    .update(Buffer.concat([get(1), get(3)])).digest());
  const current = JSON.parse(store.get("YouTubeConfig")).youtubeMusic.clientKey;
  assert(!matches(current), "the singleton config reproduces the captured overwrite race");
  const retained = versions.find(matches);
  assert(retained, "a previously observed config must authenticate the missed response");
  const key = Buffer.from(retained, "base64"), result = await client(input, key, {store, settings: {prewarm: false}});
  assert(result.output.body, "the actual missed metadata must now be transformed");
  assert.equal(new URL(result.calls.find(call => call.url.includes("/transform?")).url).searchParams.get("ck"), retained);
  assert((await worker.__test.processUmpResponse(input, key)).removed > 0, "captured startup contains ad metadata");
  assert.equal((await worker.__test.processUmpResponse(result.output.body, key)).removed, 0);
  const after = worker.__test.parseUmp(result.output.body);
  assert.equal(after.length, before.length);
  encrypted = false; let changed = 0, mediaBytes = 0;
  for (let index = 0; index < before.length; index++) {
    const oldPart = before[index], newPart = after[index];
    assert.equal(newPart.type, oldPart.type);
    if (oldPart.type === 11 && encrypted) {
      encrypted = false;
      if (!Buffer.from(oldPart.data).equals(newPart.data)) changed++;
      continue;
    }
    assert(Buffer.from(oldPart.data).equals(newPart.data), "all non-metadata frames stay byte-identical");
    if (oldPart.type === 10) encrypted = worker.__test.parseProto(oldPart.data).find(field => field.no === 1 && field.wire === 0)?.value.value === 25;
    if (oldPart.type === 21) mediaBytes += oldPart.data.length;
  }
  assert(changed > 0); assert(mediaBytes > 500000);
  assert(!result.logs.some(line => /failed|refresh requested/.test(line)));
});
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
test("encrypted audio is returned before the background script or its API callback runs", async () => {
  const f = fixture({captions: true}), run = await client(f.input, f.key, {noKick: true});
  assert(run.output.body);
  assert.equal(run.calls.filter(call => /\/(?:caption|lyrics)\/prewarm$/.test(call.url)).length, 0);
  const pending = JSON.parse(run.store.get("YouTubeTranslation.PrewarmPending.v1"));
  assert.equal(pending.length, 2);
  assert(!JSON.stringify(pending).includes(token));
  assert.equal(Buffer.from(worker.__test.parseUmp(new Uint8Array(run.output.body)).at(-1).data).toString(), "audio-unchanged");
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
  assert(line.includes("youtube.init.response.js?v=20261103-4"));
  const module = fs.readFileSync(path.join(__dirname, "YouTube.Enhance.sgmodule"), "utf8");
  assert(!/\b(?:cronexp|wake-system)=/.test(module)); assert(!module.includes("youtube.prewarm.background ="));
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
test("private Music startup HAR keeps every audio frame and uses the metadata-only transform", {skip: !process.env.MUSIC_STARTUP_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.MUSIC_STARTUP_HAR_PATH, "utf8")).log.entries;
  const transforms = entries.flatMap((entry) => {
    const url = new URL(entry.request.url);
    if (url.hostname !== "youtube-init.hmtw47cv7m.workers.dev" || url.pathname !== "/transform" || entry.response.status !== 200) return [];
    const decode = (body) => Buffer.from(body.text, body.encoding === "base64" ? "base64" : "utf8");
    return [{key: Buffer.from(url.searchParams.get("ck"), "base64"),
      before: worker.__test.parseUmp(decode(entry.request.postData)), after: worker.__test.parseUmp(decode(entry.response.content))}];
  });
  let startups = 0, mediaBytes = 0;
  for (const entry of entries) {
    const url = new URL(entry.request.url), content = entry.response?.content;
    if (!url.hostname.endsWith(".googlevideo.com") || url.pathname !== "/initplayback" || url.searchParams.get("c") !== "IOS_MUSIC"
      || entry.request.method !== "POST" || entry.response.status !== 200 || content?.encoding !== "base64") continue;
    const captured = Buffer.from(content.text, "base64");
    if (captured.length < 1024 * 1024) continue;
    const parts = worker.__test.parseUmp(captured), slots = [];
    let selected = false;
    for (const [index, part] of parts.entries()) {
      if (part.type === 10) selected = worker.__test.parseProto(part.data).find((field) => field.no === 1 && field.wire === 0)?.value.value === 25;
      else if (part.type === 11 && selected) { slots.push(index); selected = false; }
    }
    const pair = transforms.find((candidate) => {
      const data = candidate.after.filter((part) => part.type === 11);
      return data.length === slots.length && data.every((part, index) => Buffer.from(part.data).equals(parts[slots[index]].data));
    });
    assert(pair, "post-rewrite HAR body must match its captured transform response");
    const clean = await client(captured, pair.key, {settings: {prewarm: false}});
    assert(clean.calls.some((call) => call.url.includes("/transform?")));
    assert(Buffer.from(clean.output.body || captured).equals(captured), "already filtered startup must be idempotent");
    // Surge records this body after rewriting. Restore only its corresponding
    // captured request metadata in memory, retaining the real media frames.
    const originalMetadata = pair.before.filter((part) => part.type === 11);
    assert.equal(originalMetadata.length, slots.length);
    slots.forEach((slot, index) => { parts[slot] = originalMetadata[index]; });
    const original = Buffer.concat(parts.map((part) => ump(part.type, Buffer.from(part.data))));
    const run = await client(original, pair.key);
    assert(run.output.body, "original captured ad metadata must be rewritten with prewarm enabled");
    assert(run.calls.some((call) => call.url.endsWith("/lyrics/prewarm")), "startup must retain lyric prewarm");
    assert(run.calls.filter((call) => new URL(call.url).hostname === "youtube-init.hmtw47cv7m.workers.dev")
      .every((call) => new URL(call.url).pathname === "/transform"),
      "audio must not be routed through the full Worker proxy");
    assert(!run.logs.some((line) => /failed|unsupported|timeout/i.test(line)));
    const before = worker.__test.parseUmp(original), after = worker.__test.parseUmp(new Uint8Array(run.output.body));
    assert.equal(after.length, before.length);
    let encrypted = false, transformed = 0;
    for (let index = 0; index < before.length; index++) {
      const oldPart = before[index], newPart = after[index];
      assert.equal(newPart.type, oldPart.type);
      if (oldPart.type === 11 && encrypted) {
        encrypted = false;
        if (!Buffer.from(newPart.data).equals(oldPart.data)) transformed++;
        continue;
      }
      assert(Buffer.from(newPart.data).equals(oldPart.data), "non-metadata data must remain byte-for-byte identical");
      if (oldPart.type === 10) encrypted = worker.__test.parseProto(oldPart.data).find((field) => field.no === 1 && field.wire === 0)?.value.value === 25;
      if (oldPart.type === 21) mediaBytes += oldPart.data.length;
    }
    assert(transformed > 0, "captured ad metadata must still be filtered");
    startups++;
  }
  assert(startups >= 2, "HAR must include both large Music startup responses");
  assert(mediaBytes > 2 * 1024 * 1024, "large audio payloads must be verified");
});
