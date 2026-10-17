const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const source = fs.readFileSync(path.join(__dirname, 'bilibili.viewunite.response.js'), 'utf8');
const moduleText = fs.readFileSync(path.join(__dirname, 'Bilibili.Enhance.sgmodule'), 'utf8');
const endpoint = 'https://grpc.biliapi.net/bilibili.app.viewunite.v1.View/AIRelateAsync';
const adType = 'type.googleapis.com/bilibili.ad.v1.SourceContentDto';

function integer(value) {
  value = BigInt(value);
  const bytes = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}
function field(number, value) {
  value = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([integer(number * 8 + 2), integer(value.length), value]);
}
function any(type, value) { return Buffer.concat([field(1, type), field(2, value)]); }
function frame(payload, gzip = false) {
  const body = gzip ? zlib.gzipSync(payload) : payload;
  const head = Buffer.alloc(5);
  head[0] = gzip ? 1 : 0;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}
function decodeFrames(body) {
  body = Buffer.from(body);
  const frames = [];
  for (let offset = 0; offset < body.length;) {
    const start = offset;
    assert(offset + 5 <= body.length);
    const flag = body[offset], size = body.readUInt32BE(offset + 1);
    offset += 5;
    assert(offset + size <= body.length);
    const value = body.subarray(offset, offset + size);
    offset += size;
    frames.push({flag, raw: body.subarray(start, offset), value: flag ? zlib.gunzipSync(value) : value});
  }
  return frames;
}
function splitFields(bytes) {
  let offset = 0;
  function read() {
    let value = 0n, shift = 0n;
    while (true) {
      assert(offset < bytes.length && shift < 70n);
      const byte = bytes[offset++]; value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
      shift += 7n;
    }
  }
  const fields = [];
  while (offset < bytes.length) {
    const start = offset, tag = Number(read()), wire = tag & 7, number = Math.floor(tag / 8);
    let value;
    if (wire === 0) read();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) { const end = Number(read()) + offset; value = bytes.subarray(offset, end); offset = end; }
    else throw new Error('Unexpected wire type');
    assert(offset <= bytes.length);
    fields.push({number, wire, value, raw: bytes.subarray(start, offset)});
  }
  return fields;
}
function run(body, options = {}) {
  let result, calls = 0;
  const context = {
    Uint8Array, DataView, console: {log() {}},
    $request: {url: options.url || endpoint, headers: options.requestHeaders || {}},
    $response: {status: options.status ?? 200, body, headers: options.headers || {'grpc-encoding': 'gzip'}},
    $argument: options.argument ?? 'View.AD="true"&LogLevel="WARN"',
    $done(value) { result = value; calls++; },
  };
  if (!options.noGzip) context.$utils = {ungzip: value => new Uint8Array(zlib.gunzipSync(value))};
  vm.runInNewContext(source, context);
  assert.equal(calls, 1);
  return result;
}
function unchanged(body, options) { assert.equal(Object.keys(run(body, options)).length, 0); }

const control = field(2, any('type.googleapis.com/bilibili.ad.v1.AdsControl', field(4, 'control')));
const normalModule = field(5, field(1, any('type.googleapis.com/example.NormalCard', field(1, 'normal recommendation'))));
const adModule = field(5, field(1, any(adType, field(2, 'synthetic ad'))));
const unknownInteger = Buffer.concat([integer(99 * 8), integer((1n << 64n) - 1n)]);
const fixed = Buffer.concat([integer(100 * 8 + 5), Buffer.from([1, 2, 3, 4])]);
const unchangedContainer = Buffer.concat([control, normalModule, unknownInteger, fixed]);
const normalRecommendations = field(2, field(1, 'normal videos and pagination'));
const otherData = field(3, field(1, adType)); // The same string outside the verified ad path is not an ad.
const original = Buffer.concat([field(1, Buffer.concat([control, adModule, normalModule, unknownInteger, fixed])), normalRecommendations, otherData]);
const expected = Buffer.concat([field(1, unchangedContainer), normalRecommendations, otherData]);

for (const gzip of [false, true]) {
  const result = run(frame(original, gzip));
  const output = decodeFrames(result.body);
  assert.equal(output.length, 1);
  assert.equal(output[0].flag, 0);
  assert.deepEqual(output[0].value, expected);
  unchanged(Buffer.from(result.body)); // Idempotence.
}
const untouchedFrame = frame(Buffer.concat([normalRecommendations, otherData]), true);
const mixed = decodeFrames(run(Buffer.concat([frame(original, true), untouchedFrame])).body);
assert.equal(mixed.length, 2);
assert.deepEqual(mixed[1].raw, untouchedFrame, 'unmodified compressed frames must remain byte-identical');
for (const argument of ['View.AD="false"', 'View.AD=0', {'View.AD': false}]) unchanged(frame(original, true), {argument});
assert(run(frame(original, true), {argument: 'View.AD=%22true%22'}).body);
assert(run(frame(original, true), {headers: {'Grpc-Encoding': 'GZIP'}}).body);
unchanged(frame(original, true), {status: 503});
unchanged(frame(original, true), {url: endpoint.replace('AIRelateAsync', 'View')});
unchanged(frame(original, true), {noGzip: true});
unchanged(frame(original, true), {headers: {'grpc-encoding': 'deflate'}});
unchanged(Buffer.from([1, 0, 0, 0]));
unchanged(Buffer.from([1, 0, 0, 0, 1, 0]));
unchanged(frame(Buffer.from([10, 255])));
unchanged(Buffer.concat([frame(original, true), Buffer.from([0])]), {});
unchanged(Buffer.alloc(0));
unchanged('not binary');
unchanged(frame(Buffer.concat([normalRecommendations, otherData]), true));

const universalHeaders = {'User-Agent': 'bili-universal/test', 'x-bili-moss-engine-type': '1'};
const cleanBody = frame(expected, true);
const responseHeaders = Object.freeze({'grpc-encoding': 'gzip', 'x-test-metadata': 'preserved'});
const headerOnly = run(cleanBody, {requestHeaders: universalHeaders, headers: responseHeaders});
assert.equal(headerOnly.headers?.['grpc-status'], '0', 'Moss engine 1 needs a visible successful gRPC status');
assert.equal(headerOnly.headers['x-test-metadata'], 'preserved');
assert(!('body' in headerOnly), 'header repair must not rewrite an already-filtered body');
assert(!('grpc-status' in responseHeaders), 'input headers must not be mutated');
unchanged(cleanBody, {requestHeaders: universalHeaders, headers: headerOnly.headers});
const bodyAndHeaders = run(frame(original, true), {requestHeaders: universalHeaders});
assert(bodyAndHeaders.body);
assert.equal(bodyAndHeaders.headers['grpc-status'], '0');
assert.equal(run(cleanBody, {requestHeaders: {'user-agent': 'bili-universal/test', 'X-Bili-Moss-Engine-Type': '1'}}).headers['grpc-status'], '0');
assert.equal(run(cleanBody, {requestHeaders: {'User-Agent': 'bili-blue/test'}}).headers['grpc-status'], '0');
for (const requestHeaders of [{}, {'User-Agent': 'bili-inter/test'}, {'User-Agent': 'bili-universal/test'},
  {'User-Agent': 'bili-universal/test', 'x-bili-moss-engine-type': '0'}, {'User-Agent': 'unrelated-client'}]) {
  unchanged(cleanBody, {requestHeaders});
}
unchanged(cleanBody, {requestHeaders: universalHeaders, headers: {'grpc-encoding': 'gzip', 'Grpc-Status': '0'}});
for (const status of ['1', '7', '13', '16', '']) {
  unchanged(frame(original, true), {requestHeaders: universalHeaders,
    headers: {'grpc-encoding': 'gzip', 'Grpc-Status': status, 'grpc-message': 'original error'}});
}
unchanged(cleanBody, {requestHeaders: universalHeaders, status: 503});
unchanged(cleanBody, {requestHeaders: universalHeaders, argument: 'View.AD=false'});
unchanged(frame(Buffer.from([10, 255])), {requestHeaders: universalHeaders});
unchanged(Buffer.concat([frame(original, true), Buffer.from([0])]), {requestHeaders: universalHeaders});
unchanged(cleanBody, {requestHeaders: universalHeaders, noGzip: true});

const rule = moduleText.split('\n').find(line => line.startsWith('BiliBili.ADBlock.view.air-relate.response.local ='));
assert(rule);
const regex = new RegExp(rule.match(/pattern=([^,]+),/)[1]);
assert(regex.test(endpoint));
assert(regex.test(endpoint.replace('grpc.biliapi.net', 'app.bilibili.com')));
assert(!regex.test(endpoint.replace('AIRelateAsync', 'AIRelateAsyncOther')));
assert(rule.includes('binary-body-mode=1') && rule.includes('View.AD="{{{View.AD}}}"'));
assert(moduleText.includes('View\\/(View|TFInfo|RelatesFeed)$'), 'existing upstream view filtering must stay intact');

const harResults = [];
if (process.env.BILIBILI_HAR_PATH) {
  const entries = JSON.parse(fs.readFileSync(process.env.BILIBILI_HAR_PATH, 'utf8')).log.entries;
  for (const [index, entry] of entries.entries()) {
    if (!entry.request.url.includes('/bilibili.app.viewunite.v1.View/AIRelateAsync') || entry.response?.status !== 200) continue;
    const input = Buffer.from(entry.response.content.text, entry.response.content.encoding === 'base64' ? 'base64' : 'utf8');
    const headers = Object.fromEntries(entry.response.headers.map(header => [header.name, header.value]));
    const requestHeaders = Object.fromEntries(entry.request.headers.map(header => [header.name, header.value]));
    const result = run(input, {headers, requestHeaders, url: entry.request.url});
    assert(result.body, 'HAR ad response must be rewritten');
    const before = splitFields(decodeFrames(input)[0].value);
    const after = splitFields(decodeFrames(result.body)[0].value);
    assert.deepEqual(after.filter(f => f.number !== 1).map(f => f.raw), before.filter(f => f.number !== 1).map(f => f.raw),
      'normal recommendations, playback-related data and unknown root fields must stay byte-identical');
    const beforeAds = splitFields(before.find(f => f.number === 1).value);
    const afterAds = splitFields(after.find(f => f.number === 1).value);
    const sourceModules = beforeAds.filter(f => f.number === 5 && f.value.includes(Buffer.from(adType)));
    assert.equal(sourceModules.length, 3);
    assert.deepEqual(afterAds.map(f => f.raw), beforeAds.filter(f => !sourceModules.includes(f)).map(f => f.raw));
    for (const module of sourceModules) assert(!Buffer.from(result.body).includes(module.value), 'ad module must be absent');
    assert.equal(result.headers?.['grpc-status'], '0');
    unchanged(Buffer.from(result.body), {headers: result.headers || headers, requestHeaders});
    harResults.push({index, removedAds: sourceModules.length, normalDataPreserved: true, idempotent: true});
  }
  assert.equal(harResults.length, 2, 'both screenshot responses must be covered');
}
const slowHarResults = [];
if (process.env.BILIBILI_SLOW_HAR_PATH) {
  const entries = JSON.parse(fs.readFileSync(process.env.BILIBILI_SLOW_HAR_PATH, 'utf8')).log.entries;
  for (const [index, entry] of entries.entries()) {
    if (!entry.request.url.includes('/bilibili.app.viewunite.v1.View/AIRelateAsync') || entry.response?.status !== 200) continue;
    const input = Buffer.from(entry.response.content.text, entry.response.content.encoding === 'base64' ? 'base64' : 'utf8');
    const headers = Object.fromEntries(entry.response.headers.map(header => [header.name, header.value]));
    const requestHeaders = Object.fromEntries(entry.request.headers.map(header => [header.name, header.value]));
    const missingStatus = !entry.response.headers.some(header => header.name.toLowerCase() === 'grpc-status');
    const result = run(input, {headers, requestHeaders, url: entry.request.url});
    assert(!('body' in result), 'B2 recommendation data is already filtered and must stay byte-identical');
    if (missingStatus) assert.equal(result.headers?.['grpc-status'], '0');
    else assert.equal(Object.keys(result).length, 0, 'successful fallback must remain untouched');
    unchanged(input, {headers: result.headers || headers, requestHeaders, url: entry.request.url});
    slowHarResults.push({index, statusRepaired: missingStatus, bodyUnchanged: true, idempotent: true});
  }
  assert.equal(slowHarResults.length, 2);
  assert.equal(slowHarResults.filter(result => result.statusRepaired).length, 1);
}
console.log(JSON.stringify({gzipAndIdentity: true, unknownFieldsPreserved: true, mixedFramesPreserved: true,
  viewAdSwitch: true, malformedFailOpen: true, moduleRule: true, grpcHeaderCompatibility: true,
  explicitErrorsPreserved: true, harResults, slowHarResults}, null, 2));
