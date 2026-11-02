const {test} = require('node:test');
const assert = require('node:assert/strict');
const {run} = require('../../Tools/Testing/surge-harness.cjs');
const bahamut = 'Rewrite/GeneralAdBlock/bahamut-adblock.js';
const token = 'https://api.gamer.com.tw/mobile_app/anime/v1/token.php?sn=12345';
const source = 'https://api.gamer.com.tw/anime/v3/video_src.php?sn=12345';
const key = 'bahamut_ad_prewarm_v2';
const request = url => ({url, headers: {'User-Agent': 'synthetic', Cookie: 'synthetic'}, method: 'GET'});
const response = body => ({status: 200, headers: {}, body});
const now = Date.parse('2026-11-02T12:00:00+08:00');
const slots = JSON.stringify({ad: {major: [1], minor: [2]}, keep: 'ordinary'});

test('Bahamut valid falsy/invalid/ordinary payloads complete once without validation or body changes', async () => {
  for (const body of ['null', 'false', '0', '[]', 'bad JSON', '{}', '{"message":"success","src":"keep"}']) {
    const result = await run(bahamut, {request: request(source), response: response(body)});
    assert.equal(result.done.length, 1, body);
    assert.deepEqual(Object.keys(result.done[0]), [], body);
    assert.equal(result.requests.length, 0, body);
    assert.equal(result.elapsed, 0, body);
  }
});

test('a token starts validation immediately and repeated tokens reuse the pending interval', async () => {
  const store = new Map();
  for (let index = 0; index < 2; index++) {
    const result = await run(bahamut, {store, now, request: request(token), response: response(slots), http: () => ({body: '{"success":true}'})});
    assert.equal(result.elapsed, 0);
    assert.equal(result.requests.length, index ? 0 : 1);
    assert.deepEqual(JSON.parse(result.done[0].body).ad, {major: [], minor: []});
    assert.equal(JSON.parse(store.get(key))['12345'].phase, 'pending');
    assert(!result.requests.some(item => item.url.includes('ad=end')));
  }
});

test('HTTP and business validation failures never clear token ads or mark completion', async () => {
  for (const failure of [{status: 403}, {status: 429}, {status: 503}, {status: 302},
    {body: '{"error":"forbidden"}'}, {body: '{"success":false}'}, {body: 'false'}, {body: '<html>login</html>'}]) {
    const result = await run(bahamut, {request: request(token), response: response(slots), http: () => failure});
    assert.equal(result.done.length, 1);
    assert.deepEqual(Object.keys(result.done[0]), []);
    assert(!JSON.parse(result.store.get(key) || '{}')['12345']);
  }
});

test('tokens without ad slots, authentication failures and successful playback never start validation', async () => {
  for (const body of ['{}', '{"ad":{"major":[],"minor":[]}}', '{"error":{"code":401},"ad":{"major":[1]}}']) {
    const result = await run(bahamut, {request: request(token), response: response(body)});
    assert.equal(result.requests.length, 0);
    assert.equal(result.elapsed, 0);
  }
});

test('playback waits only the pending remainder before a verified end and successful source retry', async () => {
  const store = new Map([[key, JSON.stringify({'12345': {phase: 'pending', startedAt: now - 20000, updatedAt: now, owner: 'token'}})]]);
  const result = await run(bahamut, {store, now, request: request(source), response: response('{"error":"ad required"}'),
    http: (_method, req) => ({body: req.url.includes('stat_ad.php') ? '{"success":true}' : '{"message":"success","src":"video"}'})});
  assert.equal(result.elapsed, 5000);
  assert.equal(result.requests.length, 2);
  assert(result.requests[0].url.includes('ad=end'));
  assert.equal(JSON.parse(result.done[0].body).src, 'video');
  assert.equal(JSON.parse(store.get(key))['12345'].phase, 'complete');
  assert(result.requests.every(item => item.timeout <= 3 && item['auto-redirect'] === false));
});

test('cold playback fits the deadline even with three slow successful requests', async () => {
  const result = await run(bahamut, {request: request(source), response: response('{"message":"ad required"}'),
    http: (_method, req) => ({delay: 3000, body: req.url.includes('stat_ad.php') ? '{}' : '{"src":"video"}'})});
  assert.equal(result.elapsed, 34000);
  assert.equal(result.done.length, 1);
  assert.equal(JSON.parse(result.done[0].body).src, 'video');
});

test('failed end and failed source retries preserve the original playback response', async () => {
  for (const failEnd of [true, false]) {
    const store = new Map([[key, JSON.stringify({'12345': {phase: 'pending', startedAt: now - 25000, updatedAt: now, owner: 'token'}})]]);
    const result = await run(bahamut, {store, now, request: request(source), response: response('{"error":"ad required"}'),
      http: (_method, req) => failEnd && req.url.includes('stat_ad.php') ? {status: 403} : {body: req.url.includes('stat_ad.php') ? '{}' : '{"error":"region restricted"}'}});
    assert.deepEqual(Object.keys(result.done[0]), []);
    assert(!JSON.parse(store.get(key) || '{}')['12345']);
  }
});

test('hung validation completes once and later callbacks cannot change state', async () => {
  const hung = await run(bahamut, {request: request(token), response: response(slots), http: () => ({hang: true})});
  assert.equal(hung.elapsed, 4000);
  assert.equal(hung.done.length, 1);
  const result = await run(bahamut, {request: request(token), response: response(slots), lateCallbacks: true,
    http: () => ({body: '{}', delay: 40000})});
  assert.equal(result.done.length, 1);
  assert(!JSON.parse(result.store.get(key) || '{}')['12345']);
});

test('multiple episodes keep bounded independent state and do not reuse unverified legacy completion', async () => {
  const store = new Map([['bahamut_ad_prewarm_v1', JSON.stringify({videoSn: '12345', status: 'complete', completedAt: now})]]);
  for (let i = 0; i < 10; i++) await run(bahamut, {store, now: now + i,
    request: request(token.replace('12345', String(12345 + i))), response: response(slots)});
  const entries = Object.values(JSON.parse(store.get(key)));
  assert.equal(entries.length, 8);
  assert(entries.every(item => item.phase === 'pending'));
});

test('Manhuashe preserves non-ad bodies, malformed JSON and unsafe numeric identifiers', async () => {
  for (const body of ['{ "id": 9007199254740993, "name": "organic" }', '{"base":{"welfare_tabbar_show":1},"id":9007199254740993}',
    'null', 'not JSON', '{"base":{"welfare_tabbar_show":0}}', '{"ordinary":true}']) {
    const result = await run('Rewrite/GeneralAdBlock/manhuashe-adblock.js', {
      request: request('https://comicapi.manhuashe.com/v1/content'), response: response(body)});
    assert.equal(result.done.length, 1);
    assert.deepEqual(Object.keys(result.done[0]), [], body);
  }
  const changed = await run('Rewrite/GeneralAdBlock/manhuashe-adblock.js', {
    request: request('https://comicapi.manhuashe.com/v1/content'), response: response('{"response":{"base":{"welfare_tabbar_show":1},"id":123}}')});
  assert.equal(JSON.parse(changed.done[0].body).response.base.welfare_tabbar_show, 0);
  assert.equal(JSON.parse(changed.done[0].body).response.id, 123);
});
