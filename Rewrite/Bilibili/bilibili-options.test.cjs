const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {run} = require('../../Tools/Testing/surge-harness.cjs');
const file = 'Rewrite/Bilibili/bilibili.adblock.request.js';
const endpoints = [
  ['Search.HotSearch', 'https://api.vc.bilibili.com/search_svr/v1/Search/recommend_words'],
  ['Dynamic.HotTopics', 'https://api.vc.bilibili.com/topic_svr/v1/topic_svr'],
  ['Dynamic.MostVisited', 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/mix_uplist'],
  ['Xlive.AD', 'https://api.live.bilibili.com/xlive/e-commerce-interface/v1/ecommerce-user/get_shopping_info'],
  ['PGC.AD', 'https://api.bilibili.com/pgc/activity/deliver/material/receive'],
  ['Search.HotSearch', 'https://grpc.biliapi.net/bilibili.app.interface.v1.Search/DefaultWords']
];

test('each optional request rule obeys its argument in both directions', async () => {
  for (const [flag, url] of endpoints) for (const enabled of [false, true]) {
    const result = await run(file, {argument: `${flag}="${enabled}"`, request: {url: url + '?keep=1', method: 'POST'}});
    assert.equal(result.done.length, 1);
    assert.equal(Boolean(result.done[0].response), enabled, flag);
    if (enabled) {
      const mock = result.done[0].response;
      assert.equal(mock.status, 200);
      assert(mock.headers['Content-Type'].startsWith(url.includes('DefaultWords') ? 'application/grpc' : 'application/json'));
      if (!url.includes('DefaultWords')) assert.equal(typeof JSON.parse(mock.body), 'object');
      else assert.equal(mock.body.length, 5);
    }
  }
});

test('MostVisited remains enabled in the app by default; unknown requests and OPTIONS pass through', async () => {
  for (const request of [{url: endpoints[2][1]}, {url: 'https://example.test/pgc/activity/deliver/material/receive'},
    {url: endpoints[0][1] + 'Extra'}, {url: endpoints[5][1], method: 'OPTIONS'}]) {
    const result = await run(file, {request});
    assert.deepEqual(Object.keys(result.done[0]), []);
  }
});

test('native PGC jq filtering obeys the option and preserves ordinary season data', () => {
  const moduleText = fs.readFileSync(path.join(__dirname, 'Bilibili.Enhance.sgmodule'), 'utf8');
  const line = moduleText.split('\n').find(line => line.startsWith('http-response-jq '));
  const template = line.slice(line.indexOf("'") + 1, line.lastIndexOf("'"));
  const initial = {data: {payment: {ad: true}, episodes: [1]}};
  for (const enabled of ['true', 'false', 'TRUE']) {
    const filter = template.replaceAll('{{{PGC.AD}}}', enabled);
    const result = JSON.parse(execFileSync('/usr/bin/jq', ['-c', filter], {input: JSON.stringify(initial), encoding: 'utf8'}));
    assert.deepEqual(result, enabled.toLowerCase() === 'true' ? {data: {episodes: [1]}} : initial);
    const ordinary = {data: {episodes: [1]}};
    assert.deepEqual(JSON.parse(execFileSync('/usr/bin/jq', ['-c', filter], {input: JSON.stringify(ordinary), encoding: 'utf8'})), ordinary);
  }
});

test('the pinned upstream differs only by the reversible decode-error signal', () => {
  const source = fs.readFileSync(path.join(__dirname, 'bilibili.adblock.response.js'), 'utf8');
  const patched = source.split('// BEGIN pinned BiliUniverse source\n')[1].split('\n// END pinned BiliUniverse source\n')[0];
  const signal = '.catch(e=>(upstreamFailed=true,d.error(e))).finally';
  assert.equal(patched.split(signal).length, 2);
  const raw = patched.replace(signal, '.catch(e=>d.error(e)).finally');
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), 'f805f7dd5dad9f43ac67ce47b9d3ac294b5848a59b1d0ea9d504707fe406f4a1');
});

test('upstream decode failures pass through without fabricating a successful grpc-status', async () => {
  const url = 'https://grpc.biliapi.net/bilibili.main.community.reply.v1.Reply/MainList';
  for (const body of [Uint8Array.from([0, 0, 0, 0, 1, 128]), Uint8Array.from([1, 0, 0, 0, 2, 1, 2])]) {
    const result = await run('Rewrite/Bilibili/bilibili.adblock.response.js', {
      request: {url, headers: {'user-agent': 'bili-blue/1.0'}},
      response: {status: 200, headers: {'content-type': 'application/grpc'}, body}});
    assert.equal(result.done.length, 1);
    assert.deepEqual(Object.keys(result.done[0]), []);
  }
});

test('valid gzip replies retain their payload processing and required blue-client status', async () => {
  const zipped = require('node:zlib').gzipSync(new Uint8Array());
  const body = new Uint8Array(zipped.length + 5); body[0] = 1;
  new DataView(body.buffer).setUint32(1, zipped.length, false); body.set(zipped, 5);
  const result = await run('Rewrite/Bilibili/bilibili.adblock.response.js', {
    request: {url: 'https://grpc.biliapi.net/bilibili.main.community.reply.v1.Reply/MainList', headers: {'user-agent': 'bili-blue/1.0'}},
    response: {status: 200, headers: {'content-type': 'application/grpc', 'grpc-encoding': 'gzip'}, body}});
  assert.equal(result.done.length, 1);
  assert.equal(result.done[0].headers['grpc-status'], '0');
  assert(result.done[0].body instanceof Uint8Array);
});

test('the upstream guard preserves explicit gRPC errors and HTTP failures before parsing', async () => {
  for (const [status, grpc] of [[200, '7'], [200, '13'], [503, '0']]) {
    const result = await run('Rewrite/Bilibili/bilibili.adblock.response.js', {request: {url: endpoints[5][1], headers: {'user-agent': 'bili-blue/1.0'}},
      response: {status, headers: {'Content-Type': 'application/grpc', 'Grpc-Status': grpc}, body: new Uint8Array(5)}});
    assert.equal(result.done.length, 1);
    assert.deepEqual(Object.keys(result.done[0]), []);
  }
});

test('normal and missing-status blue-client gRPC frames retain the upstream compatibility fix', async () => {
  for (const grpc of ['0', undefined]) {
    const result = await run('Rewrite/Bilibili/bilibili.adblock.response.js', {
      request: {url: 'https://grpc.biliapi.net/bilibili.main.community.reply.v1.Reply/MainList', headers: {'user-agent': 'bili-blue/1.0'}},
      response: {status: 200, headers: {'content-type': 'application/grpc', ...(grpc ? {'grpc-status': grpc} : {})}, body: new Uint8Array(5)}});
    assert.equal(result.done.length, 1);
    assert.equal(result.done[0].headers['grpc-status'], '0');
    assert(result.done[0].body instanceof Uint8Array);
  }
});
