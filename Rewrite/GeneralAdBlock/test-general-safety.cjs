const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {run} = require('../../Tools/Testing/surge-harness.cjs');
const bahamut = 'Rewrite/GeneralAdBlock/bahamut-adblock.js';
const token = 'https://api.gamer.com.tw/mobile_app/anime/v4/token.php?videoSn=12345';
const source = 'https://api.gamer.com.tw/anime/v1/video_src.php?videoSn=12345';
const video = 'https://media.example.test/playlist.m3u8?token=synthetic';
const playable = JSON.stringify({src: video});
const request = url => ({url, headers: {'User-Agent': 'synthetic', Cookie: 'synthetic'}, method: 'GET'});
const response = body => ({status: 200, headers: {}, body});
const slots = JSON.stringify({data: {ad: {major: [1], minor: [2]}, keep: 'ordinary'}});

test('Bahamut is exactly the user-requested source before Monday 08:01 at 7286a27', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'bahamut-adblock.js'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), '906b7981102913545d67ce405281f4a4d93406f129265bd68b92f15b6b573d91');
  const module = fs.readFileSync(path.join(__dirname, 'GeneralAdBlock.sgmodule'), 'utf8');
  assert(module.includes('bahamut-adblock.js?v=1.1.0-restore-20261103'));
});

test('restored token handling retains both serial names and completes the original validation interval', async () => {
  for (const query of ['videoSn=12345', 'sn=12345']) {
    const result = await run(bahamut, {request: request(token.replace('videoSn=12345', query)), response: response(slots)});
    assert.equal(result.done.length, 1);
    assert.deepEqual(JSON.parse(result.done[0].body), {data: {ad: {major: [], minor: []}, keep: 'ordinary'}});
    assert.equal(result.elapsed, 25000);
    assert.equal(result.requests.length, 2);
    assert(result.requests[1].url.includes('ad=end'));
  }
});

test('restored playback handles HTTP 299/code 1015 through the original wait-and-retry path', async () => {
  const result = await run(bahamut, {request: request(source), response: {...response('{"error":{"code":1015}}'), status: 299},
    http: (_method, req) => ({body: req.url.includes('stat_ad.php') ? '{}' : playable})});
  assert.equal(result.elapsed, 25000);
  assert.equal(result.requests.length, 3);
  assert(result.requests[1].url.includes('ad=end'));
  assert.equal(result.done.length, 1);
  assert.equal(result.done[0].body, playable);
});

test('restored successful playback remains unchanged and network failure preserves the original response', async () => {
  const success = await run(bahamut, {request: request(source), response: response(playable)});
  assert.equal(success.requests.length, 0);
  assert.equal(success.done[0].body, playable);
  const failure = await run(bahamut, {request: request(source), response: response('{"error":{"code":1015}}'),
    http: () => ({error: 'synthetic network failure'})});
  assert.equal(failure.done.length, 1);
  assert.deepEqual(Object.keys(failure.done[0]), []);
});

test('private Bh tokens use the restored ad-slot behavior without real I/O', {skip: !process.env.BAHAMUT_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.BAHAMUT_HAR_PATH, 'utf8')).log.entries;
  let count = 0;
  for (const entry of entries) {
    const url = new URL(entry.request.url), content = entry.response?.content;
    if (url.hostname !== 'api.gamer.com.tw' || !url.pathname.endsWith('/token.php') || entry.response.status !== 200) continue;
    const body = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    const expected = JSON.parse(body); expected.data.ad.major = []; expected.data.ad.minor = [];
    const result = await run(bahamut, {request: request(token), response: response(body)});
    assert.equal(result.done.length, 1);
    assert(JSON.stringify(JSON.parse(result.done[0].body)) === JSON.stringify(expected), 'only the two ad arrays change');
    count++;
  }
  assert.equal(count, 4);
});

test('private bh2 playback failures enter the restored baseline validation path', {skip: !process.env.BAHAMUT_PLAYBACK_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.BAHAMUT_PLAYBACK_HAR_PATH, 'utf8')).log.entries;
  let count = 0;
  for (const entry of entries) {
    const url = new URL(entry.request.url), content = entry.response?.content;
    if (url.hostname !== 'api.gamer.com.tw' || !url.pathname.endsWith('/video_src.php') || entry.response.status !== 299) continue;
    const body = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    const result = await run(bahamut, {request: request(source), response: {...response(body), status: 299},
      http: (_method, req) => ({body: req.url.includes('stat_ad.php') ? '{}' : playable})});
    assert.equal(result.elapsed, 25000);
    assert.equal(result.requests.length, 3);
    assert.equal(result.done[0].body, playable);
    count++;
  }
  assert.equal(count, 2);
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
