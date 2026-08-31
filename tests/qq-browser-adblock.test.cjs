// Run: node tests/qq-browser-adblock.test.cjs [path/to/Qq.har]
// Fixtures stay in memory; no HAR data, credentials or unpacked bundles are saved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const scriptPath = path.join(root, "Rewrite/GeneralAdBlock/qq-browser-adblock.js");
const script = new vm.Script(fs.readFileSync(scriptPath, "utf8"), { filename: scriptPath });
const url = "https://qqbrowser-r-1258344701.shiply-cdn.qq.com/reshub/0f4d2033a2/novelReader/formal/20260825124151496/Production/compress/novelReader.zip.zip";
const branch = "Object(Ht.k)()>=2047e4?R.a.createElement(nc,null):R.a.createElement(Ws,null)";
const renderer = 'function(){var e=t.props,n=e.bottomAd,o=e.canUseLeftRight,r=e.showVideoFullScreenAd,i=e.isInIntro,a=e.isFullScreenMenuShow,s=e.isInLockedChapter,c=e.isVipUser,l=e.updateFixBottomAdShowTime,u=e.curChapterInfo,d=$e.b.getSettingConfig(),p=d.bgColors,f=d.isLeftRight,m=d.brightEyeProtectMode,h=Object(mo.a)().getBottomBackground(p,m),v=Object(Ht.l)(h,G.xb.D1);return t.isBottomAdVisible()?i||s?null:!n||(null==u?void 0:u.isCurrentChapterAdsFree)?(null==u?void 0:u.isCurrentChapterAdsFree)?t.renderFixedBottomPlaceholder("QQ浏览器海量正版小说免费看"):!t.state.isShowVipCardBottom||c||Object(Ht.g)()?t.renderFixedBottomPlaceholder():Object(Ht.k)()>=2047e4?R.a.createElement(nc,null):R.a.createElement(Ws,null):R.a.createElement(k.Suspense,{fallback:R.a.createElement(g.View,null)},R.a.createElement(ic,{ad:n,showVideoFullScreenAd:r,isLeftRight:f,canUseLeftRight:o,skinColors:v,isFullScreenMenuShow:a,updateFixBottomAdShowTime:l})):null}';
const source = Buffer.from('// 尊享无广告、品质人声等6大权益 CLICK__VIP_CARD_BOTTOM\n' +
  't.renderBottomAd=' + renderer + ',t.renderBottomView=function(){};\nconst membershipStatus="unchanged";');

function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ -1) >>> 0;
}

function zip(files, descriptor = false) {
  const locals = [], directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), raw = Buffer.from(file.data);
    const method = file.method || 0, crc = crc32(raw);
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(descriptor ? 8 : 0, 6); local.writeUInt16LE(method, 8);
    if (!descriptor) {
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22);
    }
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const tail = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      tail.writeUInt32LE(0x08074b50); tail.writeUInt32LE(crc, 4);
      tail.writeUInt32LE(compressed.length, 8); tail.writeUInt32LE(raw.length, 12);
    }
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(descriptor ? 8 : 0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(local, compressed, tail); directory.push(central);
    offset += local.length + compressed.length + tail.length;
  }
  const cd = Buffer.concat(directory), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(files.length, 8); footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(cd.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, footer]);
}

// Independent ZIP decoding uses Node zlib, not the script's fflate codec.
function unzip(bytes) {
  const b = Buffer.from(bytes); let end = b.length - 22;
  while (end >= 0 && b.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0);
  let p = b.readUInt32LE(end + 16);
  assert.equal(p + b.readUInt32LE(end + 12), end);
  const files = new Map();
  for (let i = 0; i < b.readUInt16LE(end + 10); i++) {
    assert.equal(b.readUInt32LE(p), 0x02014b50);
    const n = b.readUInt16LE(p + 28), x = b.readUInt16LE(p + 30), c = b.readUInt16LE(p + 32);
    const name = b.subarray(p + 46, p + 46 + n).toString();
    const offset = b.readUInt32LE(p + 42), method = b.readUInt16LE(p + 10);
    const start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
    const endData = start + b.readUInt32LE(p + 20);
    assert.equal(b.readUInt32LE(offset), 0x04034b50);
    const data = method === 8 ? zlib.inflateRawSync(b.subarray(start, endData)) : b.subarray(start, endData);
    assert.equal(data.length, b.readUInt32LE(p + 24));
    assert.equal(crc32(data), b.readUInt32LE(p + 16));
    if (b.readUInt16LE(p + 8) & 8) {
      const d = b.readUInt32LE(endData) === 0x08074b50 ? endData + 4 : endData;
      assert.equal(b.readUInt32LE(d), crc32(data));
      assert.equal(b.readUInt32LE(d + 4), endData - start);
      assert.equal(b.readUInt32LE(d + 8), data.length);
    } else {
      assert.equal(b.readUInt32LE(offset + 14), crc32(data));
      assert.equal(b.readUInt32LE(offset + 18), endData - start);
      assert.equal(b.readUInt32LE(offset + 22), data.length);
    }
    assert(!files.has(name));
    files.set(name, { data, record: b.subarray(offset, endData) });
    p += 46 + n + x + c;
  }
  assert.equal(p, end);
  return files;
}

function fixture(code = source, options = {}) {
  const files = [
    { name: "config.json", data: '{"module":"novelReader"}' },
    { name: "0.ios.jsbundle", data: "function keepReading(){}", method: 8 },
    { name: "index.ios.jsbundle", data: code, method: options.innerMethod || 0 }
  ];
  if (options.duplicate) files.push(files[2]);
  return zip([{ name: "novelReader.zip", data: zip(files), method: options.outerMethod ?? 8 }], options.descriptor ?? true);
}

function run(body, overrides = {}) {
  let result, doneCount = 0;
  const logs = [];
  const input = new Uint8Array(body || []), before = Buffer.from(input);
  const context = {
    Uint8Array, ArrayBuffer, DataView, Uint16Array, Uint32Array,
    console: { log: message => logs.push(message) },
    $request: { url, method: "GET", headers: {}, ...overrides.request },
    $done(value) { doneCount++; result = value; }
  };
  if (!overrides.requestOnly) context.$response = { status: 200, headers: {}, body: input, ...overrides.response };
  const start = performance.now();
  script.runInNewContext(context, { timeout: 10000 });
  const ms = Math.round(performance.now() - start);
  assert.equal(doneCount, 1);
  assert(Buffer.from(input).equals(before), "original response must not be mutated");
  return { result, logs, ms };
}

function readerSource(archive) {
  return unzip(unzip(archive).get("novelReader.zip").data).get("index.ios.jsbundle").data;
}

function render(code, overrides = {}, version = 20551224) {
  const text = code.toString(), start = text.indexOf("t.renderBottomAd=") + "t.renderBottomAd=".length;
  const end = text.indexOf(",t.renderBottomView=", start);
  assert(start > 10 && end > start);
  const context = {
    t: { props: { bottomAd: null, ...overrides }, state: { isShowVipCardBottom: true },
      isBottomAdVisible: () => true, renderFixedBottomPlaceholder: () => "placeholder" },
    $e: { b: { getSettingConfig: () => ({}) } }, mo: { a: () => ({ getBottomBackground: () => null }) },
    Ht: { l: () => null, g: () => false, k: () => version }, G: { xb: { D1: null } },
    R: { a: { createElement: type => type } }, nc: "ToolRecommendCard", Ws: "VipCardBottom",
    k: { Suspense: "normalAd" }, g: { View: "View" }, ic: "normalAdComponent"
  };
  return vm.runInNewContext("(" + text.slice(start, end) + ")()", context, { timeout: 1000 });
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok " + passed + " - " + name); }
function passthrough(result) { assert.equal(Object.keys(result).length, 0); }

test("existing GeneralAdBlock module uses the dedicated naming and exact binary pattern", () => {
  const module = fs.readFileSync(path.join(root, "Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule"), "utf8");
  const lines = module.split("\n").filter(line => line.startsWith("QQ Browser"));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert(line.includes("/qq-browser-adblock.js?v=1.0.0"));
    const pattern = new RegExp(line.match(/pattern=(.*?), /)[1]);
    assert(pattern.test(url));
    assert(!pattern.test(url.replace("novelReader/formal", "search/formal")));
    assert(!pattern.test(url.replace("qqbrowser-r-", "qqbrowser-p-")));
    assert(!pattern.test(url.replace(".zip.zip", ".zip.zip.exe")));
  }
  assert(lines[1].includes("binary-body-mode=true"));
  assert(lines[1].includes("max-size=8388608"));
});
test("only conditional full-package request headers are removed", () => {
  const { result } = run(null, { requestOnly: true, request: { headers: { "If-None-Match": "old", "if-modified-since": "old", Cookie: "keep", Accept: "keep" } } });
  assert.deepEqual(Object.keys(result.headers).sort(), ["Accept", "Cookie"]);
  assert.equal(result.headers.Cookie, "keep");
});
test("range requests, unrelated hosts and non-GET requests pass through", () => {
  passthrough(run(null, { requestOnly: true, request: { headers: { Range: "bytes=100-", "If-None-Match": "keep" } } }).result);
  passthrough(run(fixture(), { request: { url: "https://example.com/novelReader.zip.zip" } }).result);
  passthrough(run(fixture(), { request: { method: "POST" } }).result);
});
test("partial, not-modified, text and oversized responses pass through", () => {
  for (const status of [206, 304, 404]) passthrough(run(fixture(), { response: { status } }).result);
  passthrough(run(null, { response: { body: "not binary" } }).result);
  passthrough(run(new Uint8Array(8 * 1024 * 1024 + 1)).result);
});
test("both outer ZIP layouts remain valid and only index.ios.jsbundle changes", () => {
  for (const options of [{ descriptor: true }, { descriptor: false }, { outerMethod: 0 }]) {
    const input = fixture(source, options), { result } = run(input);
    assert(result.body instanceof Uint8Array);
    const before = unzip(unzip(input).get("novelReader.zip").data);
    const after = unzip(unzip(result.body).get("novelReader.zip").data);
    assert.deepEqual([...before.keys()], [...after.keys()]);
    for (const [name, original] of before) {
      if (name === "index.ios.jsbundle") {
        assert.equal(original.data.length, after.get(name).data.length);
        assert(!after.get(name).data.includes(branch));
      } else assert(original.record.equals(after.get(name).record));
    }
  }
});
test("promo renders null on both version branches; normal ads, VIP and locked states stay unchanged", () => {
  const patched = readerSource(run(fixture()).result.body);
  for (const version of [20460000, 20551224]) {
    assert.equal(render(source, {}, version), version < 20470000 ? "VipCardBottom" : "ToolRecommendCard");
    assert.equal(render(patched, {}, version), null);
    for (const props of [{ bottomAd: {} }, { isVipUser: true }, { isInIntro: true }, { isInLockedChapter: true }, { curChapterInfo: { isCurrentChapterAdsFree: true } }]) {
      assert.equal(render(patched, props, version), render(source, props, version));
    }
  }
  assert(patched.includes('membershipStatus="unchanged"'));
});
test("already patched package is byte-preserving passthrough", () => {
  const first = run(fixture()).result.body;
  passthrough(run(first).result);
});
test("unknown and ambiguous source signatures pass through", () => {
  for (const code of [Buffer.from("new reader version"), Buffer.concat([source, Buffer.from(branch)]), Buffer.from(source.toString().replace("CLICK__VIP_CARD_BOTTOM", "other"))]) {
    const { result, logs } = run(fixture(code));
    passthrough(result); assert(logs.some(x => x.includes("passthrough")));
  }
});
test("invalid ZIP, CRC, expansion size, duplicate files and compressed inner source fail open", () => {
  const invalidCrc = fixture(); invalidCrc[50] ^= 1;
  const expansion = fixture();
  const directory = expansion.readUInt32LE(expansion.length - 22 + 16);
  expansion.writeUInt32LE(13 * 1024 * 1024, directory + 24);
  for (const bad of [Buffer.from("broken"), fixture().subarray(0, 80), invalidCrc, expansion, fixture(source, { duplicate: true }), fixture(source, { innerMethod: 8 })]) {
    passthrough(run(bad).result);
  }
});
test("modified response headers preserve cookies but discard stale representation metadata", () => {
  const headers = { ETag: "old", "Content-Length": "1", "Content-Encoding": "gzip", "Content-MD5": "old", "Set-Cookie": "keep", "Content-Type": "application/zip" };
  const { result } = run(fixture(), { response: { headers } });
  assert.equal(result.headers["Content-Length"], String(result.body.length));
  assert.equal(result.headers["Set-Cookie"], "keep");
  assert.equal(result.headers["Content-Type"], "application/zip");
  assert(!("ETag" in result.headers)); assert(!("Content-Encoding" in result.headers)); assert(!("Content-MD5" in result.headers));
  assert.equal(headers.ETag, "old");
});

if (process.argv[2]) test("actual Qq.har nested ZIP, unchanged files and render behavior", () => {
  const har = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const entry = har.log.entries.find(e => e.request.url === url);
  assert(entry, "expected Qq.har reader package request");
  const original = Buffer.from(entry.response.content.text, "base64");
  const { result, ms, logs } = run(original);
  assert(result.body, logs.join("\n"));
  const before = unzip(unzip(original).get("novelReader.zip").data);
  const after = unzip(unzip(result.body).get("novelReader.zip").data);
  let unchanged = 0;
  assert.deepEqual([...before.keys()], [...after.keys()]);
  for (const [name, file] of before) {
    if (name === "index.ios.jsbundle") {
      assert.equal(after.get(name).data.length, file.data.length);
      assert(after.get(name).data.equals(Buffer.from(file.data.toString().replace(branch, "null" + " ".repeat(branch.length - 4)))));
      assert.equal(render(file.data), "ToolRecommendCard");
      assert.equal(render(after.get(name).data), null);
    } else { assert(file.record.equals(after.get(name).record)); unchanged++; }
  }
  // Third implementation validates CRCs/decompression on BOTH ZIP layers.
  const verification = spawnSync("python3", ["-c", "import sys,io,zipfile; a=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert a.testzip() is None; b=zipfile.ZipFile(io.BytesIO(a.read('novelReader.zip'))); assert b.testzip() is None; print('Python ZIP CRC validation passed')"], { input: Buffer.from(result.body), encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr);
  passthrough(run(result.body).result);
  console.log(JSON.stringify({ inputBytes: original.length, outputBytes: result.body.length, executionMs: ms, unchangedFiles: unchanged, modifiedFiles: ["index.ios.jsbundle"], independentValidation: verification.stdout.trim() }));
});
console.log("Passed " + passed + " tests");
