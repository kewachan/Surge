const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {run} = require('../../Tools/Testing/surge-harness.cjs');
const bahamut = 'Rewrite/GeneralAdBlock/bahamut-adblock.js';
const token = 'https://api.gamer.com.tw/mobile_app/anime/v1/token.php?sn=12345';
const source = 'https://api.gamer.com.tw/anime/v3/video_src.php?sn=12345';
const key = 'bahamut_ad_prewarm_v3';
const video = 'https://media.example.test/playlist.m3u8?token=synthetic';
const playable = JSON.stringify({message: 'success', src: video});
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
  const store = new Map([[key, JSON.stringify({'12345': {phase: 'pending', startedAt: now - 20000, updatedAt: now, owner: 'token', generation: 'token'}})]]);
  const result = await run(bahamut, {store, now, request: request(source), response: response('{"error":"ad required"}'),
    http: (_method, req) => ({body: req.url.includes('stat_ad.php') ? '{"success":true}' : playable})});
  assert.equal(result.elapsed, 5000);
  assert.equal(result.requests.length, 2);
  assert(result.requests[0].url.includes('ad=end'));
  assert.equal(JSON.parse(result.done[0].body).src, video);
  assert.equal(JSON.parse(store.get(key))['12345'].phase, 'complete');
  assert(result.requests.every(item => item.timeout <= 3 && item['auto-redirect'] === false));
});

test('cold playback fits the deadline even with three slow successful requests', async () => {
  const result = await run(bahamut, {request: request(source), response: response('{"message":"ad required"}'),
    http: (_method, req) => ({delay: 3000, body: req.url.includes('stat_ad.php') ? '{}' : playable})});
  assert.equal(result.elapsed, 34000);
  assert.equal(result.done.length, 1);
  assert.equal(JSON.parse(result.done[0].body).src, video);
});

test('failed end and failed source retries preserve the original playback response', async () => {
  for (const failEnd of [true, false]) {
    const store = new Map([[key, JSON.stringify({'12345': {phase: 'pending', startedAt: now - 25000, updatedAt: now, owner: 'token', generation: 'token'}})]]);
    const result = await run(bahamut, {store, now, request: request(source), response: response('{"error":"ad required"}'),
      http: (_method, req) => failEnd && req.url.includes('stat_ad.php') ? {status: 403} : {body: req.url.includes('stat_ad.php') ? '{}' : '{"error":"region restricted"}'}});
    assert.deepEqual(Object.keys(result.done[0]), []);
    const saved = JSON.parse(store.get(key) || '{}')['12345'];
    if (failEnd) assert(!saved);
    else {assert.equal(saved.phase, 'ready'); assert.notEqual(saved.sourceValidated, true);}
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

test('non-ad login, region, device, payment and unknown errors never start validation', async () => {
  for (const body of [{error: 'login required'}, {error: 'region restricted'}, {message: '請先登入'},
    {error: {code: 1007, message: 'device validation failed'}}, {error: {code: 401}},
    {error: {code: 1009, message: 'ad required'}}, {error: 'premium payment required'},
    {error: 'unknown server error'}, {code: 503, message: 'ad required'},
    {error: {code: 1015, message: 'region blocked'}}]) {
    const result = await run(bahamut, {request: request(source), response: response(JSON.stringify(body))});
    assert.equal(result.requests.length, 0, JSON.stringify(body));
    assert.equal(result.elapsed, 0);
    assert.equal(result.done.length, 1);
    assert.deepEqual(Object.keys(result.done[0]), []);
  }
});

test('v4 videoSn and the legacy sn identify the same episode without accepting conflicting IDs', async () => {
  for (const query of ['videoSn=12345', 'sn=12345', 'videoSn=12345&sn=12345', 'videoSn=%31%32%33%34%35']) {
    const result = await run(bahamut, {request: request('https://api.gamer.com.tw/mobile_app/anime/v4/token.php?device=synthetic&' + query),
      response: response(slots)});
    assert.deepEqual(JSON.parse(result.done[0].body).ad, {major: [], minor: []});
    assert(result.requests[0].url.endsWith('&sn=12345'));
  }
  for (const query of ['videoSn=12345&sn=67890', 'videoSn=12345&sn=invalid', 'notvideoSn=12345', 'videoSn=%ZZ']) {
    const result = await run(bahamut, {request: request('https://api.gamer.com.tw/mobile_app/anime/v4/token.php?' + query), response: response(slots)});
    assert.equal(result.requests.length, 0);
    assert.deepEqual(Object.keys(result.done[0]), []);
  }
});

test('generic legacy playback errors retain compatibility only with an active ad token', async () => {
  const pending = {phase: 'pending', startedAt: now - 20000, updatedAt: now, generation: 'token', owner: 'token'};
  const good = await run(bahamut, {store: new Map([[key, JSON.stringify({'12345': pending})]]),
    request: request(source.replace('sn=', 'videoSn=')), response: response('{"message":"source not ready"}'),
    http: (_method, req) => ({body: req.url.includes('stat_ad.php') ? '{}' : playable})});
  assert.equal(good.elapsed, 5000);
  assert.equal(good.done[0].body, playable);
  for (const body of [{error: 'login required'}, {error: 'region restricted'}, {error: {code: 1007}}]) {
    const result = await run(bahamut, {store: new Map([[key, JSON.stringify({'12345': pending})]]),
      request: request(source), response: response(JSON.stringify(body))});
    assert.equal(result.requests.length, 0);
  }
});

test('private Bh HAR v4 tokens clear only ad slots and preserve the actual account/player fields', {skip: !process.env.BAHAMUT_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.BAHAMUT_HAR_PATH, 'utf8')).log.entries;
  const store = new Map(); let replayed = 0;
  for (const entry of entries) {
    const url = new URL(entry.request.url);
    if (url.hostname !== 'api.gamer.com.tw' || url.pathname !== '/mobile_app/anime/v4/token.php' || entry.response?.status !== 200) continue;
    const content = entry.response.content;
    const body = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    const original = JSON.parse(body);
    assert(original.data.ad.major.length > 0 && original.data.ad.minor.length > 0);
    const result = await run(bahamut, {store, request: request(entry.request.url), response: response(body)});
    assert.equal(result.done.length, 1);
    assert(result.done[0].body, 'captured v4 token must be processed');
    const expected = JSON.parse(body); expected.data.ad.major = []; expected.data.ad.minor = [];
    assert(JSON.stringify(JSON.parse(result.done[0].body)) === JSON.stringify(expected), 'only the two ad-slot arrays may change');
    assert(result.requests.every(req => new URL(req.url).searchParams.get('sn') === url.searchParams.get('videoSn')));
    replayed++;
  }
  assert(replayed > 0, 'HAR must contain v4 token replies');
});

test('known ad-wait signals retain the bounded validation flow and accept complete source schemas', async () => {
  const errors = [{error: {code: 1015}}, {error: {code: '1015'}}, {message: '尚未觀看完畢廣告'}, {error: 'advertisement is pending'}];
  const bodies = [{src: video}, {data: {src: {playlist: video}}}, {url: video}, {data: {sources: [{url: video}]}}];
  for (let i = 0; i < errors.length; i++) {
    const result = await run(bahamut, {request: request(source), response: response(JSON.stringify(errors[i])),
      http: (_method, req) => ({body: req.url.includes('stat_ad.php') ? '{}' : JSON.stringify(bodies[i])})});
    assert.equal(result.elapsed, 25000);
    assert.equal(result.done[0].body, JSON.stringify(bodies[i]));
    assert.equal(JSON.parse(result.store.get(key))['12345'].sourceValidated, true);
  }
});

test('HTTP 299 ad-wait responses complete validation and relay the successful retry status', async () => {
  for (const code of [1015, '1015']) {
    const pending = {phase: 'pending', startedAt: now - 20000, updatedAt: now, generation: 'token', owner: 'token'};
    const result = await run(bahamut, {now, store: new Map([[key, JSON.stringify({'12345': pending})]]),
      request: request(source.replace('sn=', 'videoSn=')),
      response: {...response(JSON.stringify({error: {code, message: '影片載入失敗，請重新整理。'}})), status: 299},
      http: (_method, req) => ({status: 200, body: req.url.includes('stat_ad.php') ? '{}' : playable})});
    assert.equal(result.elapsed, 5000);
    assert.equal(result.requests.length, 2);
    assert(result.requests[0].url.includes('ad=end'));
    assert.equal(result.done.length, 1);
    assert.equal(result.done[0].status, 200, 'valid retry must replace the original error status');
    assert.equal(result.done[0].body, playable);
    assert.equal(JSON.parse(result.store.get(key))['12345'].sourceValidated, true);
  }
});

test('HTTP 299 compatibility is confined to playback ad-wait code 1015', async () => {
  const pending = {phase: 'pending', startedAt: now - 25000, updatedAt: now, generation: 'token', owner: 'token'};
  for (const [url, body, status] of [[source, {error: {code: 1007}}, 299], [source, {error: {code: 401}}, 299],
    [source, {error: 'ad required'}, 299], [source, {src: video}, 299],
    [source, {error: {code: 1015, message: 'region blocked'}}, 299],
    [source, {error: {code: 1015}}, 403], [source, {error: {code: 1015}}, 503],
    [token, {ad: {major: [1], minor: [2]}}, 299]]) {
    const store = new Map([[key, JSON.stringify({'12345': pending})]]), saved = store.get(key);
    const result = await run(bahamut, {store, now, request: request(url), response: {...response(JSON.stringify(body)), status}});
    assert.deepEqual(Object.keys(result.done[0]), []);
    assert.equal(result.requests.length, 0);
    assert.equal(store.get(key), saved, 'unrelated server errors must not change validation state');
  }
});

test('failed HTTP 299 recovery preserves the original status/body and never marks a source complete', async () => {
  for (const failure of [{status: 299, body: '{"error":{"code":1015}}'}, {status: 200, body: '{}'},
    {status: 403, body: playable}, {error: 'timeout'}]) {
    const pending = {phase: 'pending', startedAt: now - 25000, updatedAt: now, generation: 'token', owner: 'token'};
    const result = await run(bahamut, {now, store: new Map([[key, JSON.stringify({'12345': pending})]]),
      request: request(source), response: {...response('{"error":{"code":1015}}'), status: 299},
      http: (_method, req) => req.url.includes('stat_ad.php') ? {body: '{}'} : failure});
    assert.equal(result.requests.length, 2, 'the source recovery must actually be attempted');
    assert.equal(result.done.length, 1);
    assert.deepEqual(Object.keys(result.done[0]), []);
    assert.notEqual(JSON.parse(result.store.get(key))['12345']?.phase, 'complete');
  }
});

test('private bh2 HAR playback errors enter validation without replaying device credentials', {skip: !process.env.BAHAMUT_PLAYBACK_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.BAHAMUT_PLAYBACK_HAR_PATH, 'utf8')).log.entries;
  let replays = 0;
  for (const entry of entries) {
    const url = new URL(entry.request.url), content = entry.response?.content;
    if (url.hostname !== 'api.gamer.com.tw' || !/\/(?:m3u8|video_src)\.php$/.test(url.pathname) || entry.response.status !== 299) continue;
    const body = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, 1015);
    // Only the route, parameter name and response are needed. Real identifiers,
    // authentication and cookies must not enter the synthetic I/O or assertions.
    const name = url.searchParams.has('videoSn') ? 'videoSn' : 'sn';
    const result = await run(bahamut, {request: request(`${url.origin}${url.pathname}?${name}=12345`),
      response: {...response(body), status: entry.response.status},
      http: (_method, req) => ({status: 200, body: req.url.includes('stat_ad.php') ? '{}' : playable})});
    assert.equal(result.elapsed, 25000);
    assert.equal(result.requests.length, 3, 'start, end and source retry must all occur');
    assert(result.requests[1].url.includes('ad=end'));
    assert.equal(result.done[0].status, 200);
    assert.equal(result.done[0].body, playable);
    replays++;
  }
  assert(replays >= 2, 'fixture must contain both captured playback failures');
});

test('empty or malformed playback successes preserve the original error and cannot leave complete state', async () => {
  for (const body of ['{}', '{"success":true}', '{"src":""}', '{"src":"not-a-url"}', '{"data":{"src":{}}}',
    '{"code":"403","src":"https://example.test/denied"}', 'null', 'false', '<html>login</html>']) {
    const result = await run(bahamut, {request: request(source), response: response('{"error":{"code":1015}}'),
      http: (_method, req) => ({body: req.url.includes('stat_ad.php') ? '{}' : body})});
    assert.equal(result.done.length, 1);
    assert.deepEqual(Object.keys(result.done[0]), []);
    assert(JSON.parse(result.store.get(key) || '{}')['12345']?.phase !== 'complete');
  }
});

test('old completions and unverified complete records cannot skip a fresh validation', async () => {
  const state = {phase: 'complete', startedAt: now - 30000, updatedAt: now - 5000, owner: 'old', generation: 'old', sourceValidated: true};
  for (const [storedKey, saved] of [[key, state], ['bahamut_ad_prewarm_v2', state], [key, {...state, sourceValidated: false}]]) {
    const result = await run(bahamut, {store: new Map([[storedKey, JSON.stringify({'12345': saved})]]),
      request: request(source), response: response('{"error":{"code":1015}}'),
      http: (_method, req) => ({body: req.url.includes('stat_ad.php') ? '{}' : playable})});
    assert.equal(result.elapsed, 25000);
    assert.equal(result.requests.filter(req => req.url.includes('stat_ad.php')).length, 2);
  }
});

async function simultaneous(options = {}) {
  const text = fs.readFileSync(path.join(__dirname, 'bahamut-adblock.js'), 'utf8');
  const store = options.store || new Map(), timers = new Map(), sessions = [];
  let elapsed = 0, next = 0;
  class Clock extends Date {
    constructor(...args) {super(...(args.length ? args : [now + elapsed]));}
    static now() {return now + elapsed;}
  }
  const timer = (fn, ms) => {const id = ++next; timers.set(id, {fn, at: elapsed + ms}); return id;};
  for (const spec of options.sessions || [{}, {}, {startAt: 500}]) {
    const session = {done: [], requests: [], completedAt: null}; sessions.push(session);
    const context = {Date: Clock, console: {log() {}}, setTimeout: timer, clearTimeout: id => timers.delete(id),
      $request: request(spec.token ? token : source),
      $response: response(spec.token ? slots : '{"error":{"code":1015}}'),
      $persistentStore: {read: key => store.get(key) ?? null,
        write(value, key) {value === null ? store.delete(key) : store.set(key, value); return true;}},
      $httpClient: {get(input, callback) {
        session.requests.push(input);
        const reply = options.http?.(input, elapsed, store) || {
          status: 200, body: input.url.includes('stat_ad.php') ? '{}' : playable, delay: input.url.includes('stat_ad.php') ? 1000 : 0};
        if (!reply.hang) timer(() => callback(reply.error || null, {status: reply.status ?? 200}, reply.body), reply.delay || 0);
      }},
      $done(value) {session.done.push(value); session.completedAt = elapsed;}};
    timer(() => vm.runInNewContext(text, context, {timeout: 3000}), spec.startAt || 0);
  }
  const flush = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
  for (let step = 0; step < 3000 && timers.size && sessions.some(session => !session.done.length); step++) {
    const [id, item] = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    timers.delete(id); elapsed = item.at; item.fn(); await flush();
  }
  return {sessions, store, elapsed, requests: sessions.flatMap(session => session.requests)};
}

test('concurrent playback sessions share one end validation and all receive a usable source', async () => {
  for (const warm of [true, false]) {
    const store = warm ? new Map([[key, JSON.stringify({'12345': {
      phase: 'pending', startedAt: now - 25000, updatedAt: now, owner: 'token', generation: 'token'}})]]) : new Map();
    const result = await simultaneous({store});
    for (const session of result.sessions) {
      assert.equal(session.done.length, 1);
      assert.equal(session.done[0].body, playable);
      assert(session.completedAt < 36000);
    }
    const stats = result.requests.filter(req => req.url.includes('stat_ad.php'));
    assert.equal(stats.filter(req => req.url.includes('ad=end')).length, 1);
    assert.equal(stats.length, warm ? 1 : 2);
  }
});

test('parallel tokens join starting validation without repeating it or waiting out the ad interval', async () => {
  const result = await simultaneous({sessions: [{token: true}, {token: true, startAt: 100}]});
  assert.equal(result.requests.length, 1);
  for (const session of result.sessions) {
    assert.equal(session.done.length, 1);
    assert.deepEqual(JSON.parse(session.done[0].body).ad, {major: [], minor: []});
    assert(session.completedAt < 4000);
  }
});

test('a shared end failure releases every waiter with its original response and no source retry', async () => {
  const store = new Map([[key, JSON.stringify({'12345': {
    phase: 'pending', startedAt: now - 25000, updatedAt: now, owner: 'token', generation: 'token'}})]]);
  const result = await simultaneous({store, http: () => ({status: 403, body: '{}', delay: 1000})});
  assert.equal(result.requests.length, 1);
  for (const session of result.sessions) {
    assert.equal(session.done.length, 1);
    assert.deepEqual(Object.keys(session.done[0]), []);
  }
  assert(!JSON.parse(store.get(key) || '{}')['12345']);
});

test('one malformed source cannot erase accepted validation for a nearby retry, and ready state is not complete', async () => {
  const store = new Map([[key, JSON.stringify({'12345': {
    phase: 'pending', startedAt: now - 25000, updatedAt: now, owner: 'token', generation: 'token'}})]]);
  let sources = 0;
  const result = await simultaneous({store, sessions: [{}, {startAt: 1500}, {startAt: 3000}], http: req =>
    req.url.includes('stat_ad.php') ? {body: '{}', delay: 1000}
      : {body: ++sources === 1 ? '{}' : playable}});
  assert.deepEqual(Object.keys(result.sessions[0].done[0]), []);
  assert.equal(result.sessions[1].done[0].body, playable);
  assert.equal(result.sessions[2].done[0].body, playable);
  assert.equal(result.requests.filter(req => req.url.includes('stat_ad.php')).length, 1);
  assert.equal(JSON.parse(store.get(key))['12345'].sourceValidated, true);
});

test('late old-generation sources do not overwrite a newer validation owner', async () => {
  const next = {phase: 'pending', startedAt: now, updatedAt: now, owner: 'next', generation: 'next'};
  const store = new Map();
  const result = await run(bahamut, {store, request: request(source), response: response('{"error":{"code":1015}}'),
    http: (_method, req) => {
      if (req.url.includes('stat_ad.php')) return {body: '{}'};
      store.set(key, JSON.stringify({'12345': {...next, startedAt: now + 25000, updatedAt: now + 25000}}));
      return {body: playable};
    }});
  assert.equal(result.done[0].body, playable);
  assert.equal(JSON.parse(store.get(key))['12345'].generation, 'next');
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
