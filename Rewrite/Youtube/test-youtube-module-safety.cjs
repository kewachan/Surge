const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {run} = require('../../Tools/Testing/surge-harness.cjs');
const {loadClient} = require('./test-youtube-lyrics-order.cjs');
const moduleText = fs.readFileSync(path.join(__dirname, 'YouTube.Enhance.sgmodule'), 'utf8');

let promoProto;
function promoVarint(value) {
  const bytes = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
const promoField = (number, bytes) => Buffer.concat([promoVarint(number * 8 + 2), promoVarint(Buffer.byteLength(bytes)), Buffer.from(bytes)]);
const promoScalar = (number, value) => Buffer.concat([promoVarint(number * 8), promoVarint(value)]);
const promoText = text => promoField(1, promoField(1, text));
function musicPromoFixture(options = {}) {
  const button = promoField(65153809, Buffer.concat([promoField(5, promoText('Get Music Premium')),
    promoField(9, promoField(48687626, promoField(2, 'SPunlimited')))]));
  const renderer = Buffer.concat([promoField(1, button), promoField(2,
    promoText(options.description || 'Enjoy ad-free music, listen in audio mode, and play music offline.'))]);
  const promo = options.promo ?? promoField(options.renderer ?? 104347096, renderer);
  const metadata = options.metadata ?? Buffer.concat([promoField(3, button), promoScalar(4, 0),
    promoField(7, Buffer.from([255, 0, 128])), ...(options.absent ? [] : [promoField(8, promo)]),
    promoField(9, 'first-unknown'), promoField(9, 'second-unknown'), promoScalar(24, 1)]);
  const envelope = options.envelope ?? Buffer.concat([promoField(123, 'envelope-sibling'), promoField(100625508, metadata)]);
  return Buffer.concat([promoField(9, promoField(199000001, 'ordinary-results')),
    options.rootField ?? promoField(15, envelope), promoScalar(34, 1), promoField(777, Buffer.from([255, 0]))]);
}
function promoNode(bytes, numbers) {
  for (const number of numbers) bytes = promoProto(bytes).find(field => field.no === number && field.wire === 2)?.value;
  assert(bytes, 'expected metadata path must exist');
  return bytes;
}
function assertPromoSiblings(before, after) {
  for (const [numbers, changed] of [[[], 15], [[15], 100625508], [[15, 100625508], 8]]) {
    const original = promoProto(promoNode(before, numbers)).filter(field => field.no !== changed);
    const actual = promoProto(promoNode(after, numbers)).filter(field => field.no !== changed);
    assert(original.length === actual.length && original.every((field, i) => Buffer.from(field.raw).equals(actual[i].raw)),
      'all unrelated fields, including repeated fields, must stay byte-identical');
  }
  assert(!promoProto(promoNode(after, [15, 100625508])).some(field => field.no === 8), 'only the side-panel promo is removed');
}
function assertPromoUnchanged(result, input) {
  assert.equal(result.done.length, 1);
  const output = result.done[0].body;
  if (output) assert(Buffer.from(output).equals(input), 'the existing browse pass-through must keep the original bytes');
  else assert.deepEqual(Object.keys(result.done[0]), []);
}
async function musicPromoRun(body, options = {}) {
  if (!promoProto) {
    const source = fs.readFileSync(path.join(__dirname, 'youtube.worker.js'), 'utf8');
    promoProto = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).__test.parseProto;
  }
  return run('Rewrite/Youtube/youtube.response.js', {
    store: options.store, argument: '{"captionLang":"off","lyricsLang":"off","prewarm":false}',
    request: {url: `https://youtubei.googleapis.com/youtubei/v1/${options.endpoint || 'browse'}`,
      headers: {[options.headerName || 'User-Agent']: options.userAgent ?? 'com.google.ios.youtubemusic/9.43.2'}},
    response: {status: options.status ?? 200, headers: {'Content-Type': 'application/x-protobuf'}, body: new Uint8Array(body)},
  });
}

test('Music Account promo removal preserves account metadata and works in different languages', async () => {
  for (const description of ['Enjoy ad-free music, listen in audio mode, and play music offline.', 'Profitez de votre musique sans publicite.']) {
    const input = musicPromoFixture({description}), store = new Map([['YouTubePlaybackKeys.v2.youtubeMusic', 'existing-keys']]);
    const result = await musicPromoRun(input, {store, headerName: 'user-agent'});
    assert.equal(result.done.length, 1); assert(result.done[0].body, 'the known optional promo must be removed');
    const output = Buffer.from(result.done[0].body);
    assertPromoSiblings(input, output);
    assert(!output.includes(Buffer.from(description)));
    assert(output.includes(Buffer.from('Get Music Premium')), 'the separate Premium settings entry remains available');
    assert.equal(store.get('YouTubePlaybackKeys.v2.youtubeMusic'), 'existing-keys');
    assert.equal(result.requests.length, 0); assert.equal(result.apiCalls.length, 0);
    const repeat = await musicPromoRun(output, {store});
    assertPromoUnchanged(repeat, output);
  }
});

test('Music Account promo removal is restricted to Music browse responses', async () => {
  const input = musicPromoFixture();
  for (const options of [{userAgent: 'com.google.ios.youtube/21.43.3'}, {userAgent: ''},
    {endpoint: 'next'}, {endpoint: 'search'}, {endpoint: 'guide'}, {endpoint: 'next?ref=browse'},
    {status: 403}, {status: 500}]) {
    const result = await musicPromoRun(input, options);
    assertPromoUnchanged(result, input);
    assert.equal(result.requests.length, 0); assert.equal(result.apiCalls.length, 0);
  }
});

test('Music Account promo removal preserves absent, unknown and malformed optional metadata', async () => {
  const inputs = [musicPromoFixture({absent: true}), musicPromoFixture({renderer: 104347097}),
    musicPromoFixture({promo: promoField(104347096, Buffer.alloc(0))}),
    musicPromoFixture({promo: Buffer.from([0x0a, 0xff])}),
    musicPromoFixture({metadata: promoScalar(8, 1)}),
    musicPromoFixture({envelope: Buffer.from([0x0a, 0xff])}),
    musicPromoFixture({rootField: promoScalar(15, 1)})];
  for (const input of inputs) {
    const result = await musicPromoRun(input);
    assertPromoUnchanged(result, input);
    assert.equal(result.requests.length, 0); assert.equal(result.apiCalls.length, 0);
  }
});

test('private Music home HAR removes the exact Account footer and preserves existing ad filtering', {
  skip: !process.env.MUSIC_PROMO_HAR_PATH,
}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.MUSIC_PROMO_HAR_PATH, 'utf8')).log.entries;
  const description = 'Enjoy ad-free music, listen in audio mode, and play music offline.';
  const decode = content => Buffer.from(content?.text || '', content?.encoding === 'base64' ? 'base64' : 'utf8');
  const captured = entries.filter(entry => new URL(entry.request.url).pathname === '/youtubei/v1/browse' &&
    decode(entry.response?.content).includes(Buffer.from(description)));
  assert(captured.length > 0, 'capture must contain the exact requested footer');
  for (const entry of captured) {
    const input = decode(entry.response.content), result = await musicPromoRun(input);
    assert.equal(result.done.length, 1); assert(result.done[0].body);
    const output = Buffer.from(result.done[0].body);
    assert(!output.includes(Buffer.from(description))); assert(output.includes(Buffer.from('Get Music Premium')));
    const file = path.join(__dirname, 'youtube.response.js'), read = fs.readFileSync;
    const source = read(file, 'utf8'), marker = 'const promoBody = removeMusicSidePanelPromo(bodyBytes || l.bodyBytes);';
    assert(source.includes(marker));
    let baseline;
    try {
      fs.readFileSync = function (name, ...args) {
        return path.resolve(String(name)) === file ? source.replace(marker, 'const promoBody = null;') : read.call(this, name, ...args);
      };
      baseline = await musicPromoRun(input);
    } finally { fs.readFileSync = read; }
    assertPromoSiblings(baseline.done[0].body || input, output);
    assert.equal(result.requests.length, 0); assert.equal(result.apiCalls.length, 0);
  }
});

test('initplayback requires an exact ack query key in any position', () => {
  const line = moduleText.split('\n').find(line => line.startsWith('youtube.init_playback.request'));
  const regex = new RegExp(/pattern=(.*?),requires-body=/.exec(line)[1]);
  const base = 'https://rr1---sn-test.googlevideo.com/initplayback?';
  for (const query of ['ack=1&c=IOS', 'c=IOS&ack=1', 'c=IOS&ack=', 'c=IOS&ack=1&x=1']) assert(regex.test(base + query));
  for (const query of ['c=IOS&acknowledge=1', 'notack=1', 'x=literal%26ack%3D1', 'x=1#ack=1']) assert(!regex.test(base + query));
  assert(!regex.test('https://googlevideo.com.example.test/initplayback?ack=1'));
  assert(!regex.test(base.replace('initplayback', 'videoplayback') + 'ack=1'));
});

test('expired/rejected/unavailable AI services use Google; invalid payloads do not retry another provider', async () => {
  const lines = ['A gentle breeze', 'An evening sky'];
  for (const status of [400, 401, 403, 404, 405, 410, 413, 415, 422, 429, 500, 502]) {
    const calls = [];
    const {client} = loadClient({httpClient: {
      post(_request, callback) { calls.push('worker'); callback(null, {status}, 'synthetic failure'); },
      get(_request, callback) {
        calls.push('google');
        callback(null, {status: 200}, JSON.stringify([[[lines.map(() => '谷歌譯文').join('\n[[YTL:1]]\n')]]]));
      }
    }});
    const result = client.fetchTranslations(lines, 'zh-Hant', Date.now() + 9000, 'a'.repeat(64));
    if ([400, 413, 415, 422].includes(status)) {
      await assert.rejects(result);
      assert.deepEqual(calls, ['worker']);
    } else {
      assert.equal((await result).provider, 'google-translate');
      assert.deepEqual(calls, ['worker', 'google']);
    }
  }
});

const epoch = Date.parse('2026-11-02T12:00:00+08:00');
function cacheApi(kind, options = {}) {
  const store = options.store || new Map(), clock = options.clock || {value: epoch};
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.value])); }
    static now() { return clock.value; }
  }
  const file = kind === 'prewarm' ? 'youtube.prewarm.client.js' : `youtube.${kind}.js`;
  let text = fs.readFileSync(path.join(__dirname, file), 'utf8');
  if (kind === 'caption') {
    const offset = text.lastIndexOf('if (typeof $response === "undefined") {');
    assert(offset > 0);
    text = text.slice(0, offset) + '\nglobalThis.client={writeCachedParts,readCachedParts,writeCaptionJob,readCaptionJob,clearCaptionJob};';
  } else if (kind === 'lyrics') {
    const marker = '  main().catch((error) => {';
    assert(text.includes(marker));
    text = text.replace(marker, '  globalThis.client={writeCache,readCache,clearLegacyCaches};return;\n' + marker);
  } else {
    const marker = '  $done = (result) => {';
    assert(text.includes(marker));
    text = text.replace(marker, '  globalThis.client={remember};return;\n' + marker);
  }
  const context = {Date: Clock, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, URLSearchParams,
    console: {log() {}}, $argument: '{}', $request: {url: 'https://example.test/', headers: {}}, $response: {}, $done() {},
    $persistentStore: {read: key => store.get(key) ?? null, write(value, key) {
      if (options.rejectWrite?.(value, key)) return false;
      value === null ? store.delete(key) : store.set(key, value); return true;
    }}};
  vm.runInNewContext(text, context, {filename: file, timeout: 3000});
  return {client: context.client, store, clock};
}

test('caption and AI lyric caches delete expired values before removing index entries', () => {
  for (const kind of ['caption', 'lyrics']) {
    const {client, store, clock} = cacheApi(kind);
    const prefix = kind === 'caption' ? 'YouTubeCaption.v6.' : 'YouTubeLyrics.v6.';
    const indexKey = kind === 'caption' ? 'YouTubeCaption.CacheIndex.v6' : 'YouTubeLyrics.CacheIndex.v7';
    const limit = kind === 'caption' ? 96 : 64, days = kind === 'caption' ? 7 : 14;
    for (let generation = 0; generation < 3; generation++) {
      clock.value = epoch + generation * (days * 86400000 + 1);
      for (let i = 0; i < limit + 4; i++) {
        const key = prefix + `${generation}-${i}`;
        if (kind === 'caption') client.writeCachedParts(key, ['translated']);
        else client.writeCache(key, {provider: 'cloudflare-ai', translations: ['translated']});
      }
      assert.equal([...store.keys()].filter(key => key.startsWith(prefix)).length, limit);
      assert.equal(JSON.parse(store.get(indexKey)).length, limit);
      assert([...store.values()].every(value => value !== ''), 'empty strings are values, not native deletions');
    }
  }
});

test('caption jobs are bounded, expire across new videos, and invalid future metadata is removed', () => {
  const {client, store, clock} = cacheApi('caption');
  const prefix = 'YouTubeCaption.Job.v20.', id = '11111111-1111-1111-1111-111111111111';
  for (let i = 0; i < 200; i++) {
    clock.value = epoch + i * 86400000;
    client.writeCaptionJob(prefix + i, id, 2);
  }
  assert.equal([...store.keys()].filter(key => key.startsWith(prefix)).length, 7);
  assert.equal(client.readCaptionJob(prefix + 199, 2), id);
  client.clearCaptionJob(prefix + 199);
  assert(!store.has(prefix + 199));
  store.set(prefix + 'future', JSON.stringify({jobId: id, itemCount: 2, savedAt: clock.value + 1}));
  assert.equal(client.readCaptionJob(prefix + 'future', 2), '');
  assert(!store.has(prefix + 'future'));
  for (let i = 0; i < 120; i++) client.writeCaptionJob(prefix + 'burst' + i, id, 2);
  assert.equal([...store.keys()].filter(key => key.startsWith(prefix)).length, 96);
});

test('corrupt cache indices recover without deleting unrelated settings or credentials', () => {
  for (const kind of ['caption', 'lyrics']) {
    const {client, store} = cacheApi(kind);
    const index = kind === 'caption' ? 'YouTubeCaption.CacheIndex.v6' : 'YouTubeLyrics.CacheIndex.v7';
    const key = (kind === 'caption' ? 'YouTubeCaption.v6.' : 'YouTubeLyrics.v6.') + 'synthetic';
    const write = () => kind === 'caption' ? client.writeCachedParts(key, ['translated'])
      : client.writeCache(key, {provider: 'cloudflare-ai', translations: ['translated']});
    store.set('unrelated-setting', 'keep');
    store.set(index, JSON.stringify([{key: 'unrelated-setting', savedAt: 1}, null])); write();
    assert.equal(store.get('unrelated-setting'), 'keep');
    store.set(index, 'invalid JSON'); write();
    assert.equal(JSON.parse(store.get(index))[0].key, key);
  }
});

test('failed cache deletes stay indexed and recover when storage is writable', () => {
  for (const kind of ['caption', 'lyrics']) {
    let reject = true;
    const {client, store} = cacheApi(kind, {rejectWrite: value => value === null && reject});
    const prefix = kind === 'caption' ? 'YouTubeCaption.v6.' : 'YouTubeLyrics.v6.';
    const index = kind === 'caption' ? 'YouTubeCaption.CacheIndex.v6' : 'YouTubeLyrics.CacheIndex.v7';
    const old = prefix + 'old';
    store.set(old, 'expired'); store.set(index, JSON.stringify([{key: old, savedAt: 1, expiresAt: 2}]));
    const write = key => kind === 'caption' ? client.writeCachedParts(key, ['translated'])
      : client.writeCache(key, {provider: 'cloudflare-ai', translations: ['translated']});
    write(prefix + 'new');
    assert(JSON.parse(store.get(index)).some(item => item.key === old));
    reject = false; write(prefix + 'retry');
    assert(!store.has(old));
  }
});

test('prewarm eviction uses native deletion and preserves unrelated data', () => {
  const {client, store} = cacheApi('prewarm');
  store.set('private-setting', 'keep');
  store.set('YouTubeTranslation.PrewarmIndex.v1', JSON.stringify([{key: 'private-setting'}]));
  for (let i = 0; i < 100; i++) client.remember('YouTubeCaption.Prewarm.v1.' + i, {savedAt: epoch});
  assert.equal([...store.keys()].filter(key => key.startsWith('YouTubeCaption.Prewarm.v1.')).length, 64);
  assert.equal(store.get('private-setting'), 'keep');
  assert([...store.values()].every(value => value !== ''));
});

test('a failed index write cannot strand a new cache value outside its index', () => {
  for (const kind of ['caption', 'lyrics', 'prewarm']) {
    const indices = new Set(['YouTubeCaption.CacheIndex.v6', 'YouTubeCaption.JobIndex.v20',
      'YouTubeLyrics.CacheIndex.v7', 'YouTubeTranslation.PrewarmIndex.v1']);
    const {client, store} = cacheApi(kind, {rejectWrite: (_value, key) => indices.has(key)});
    const key = kind === 'lyrics' ? 'YouTubeLyrics.v6.synthetic' : kind === 'prewarm'
      ? 'YouTubeCaption.Prewarm.v1.synthetic' : 'YouTubeCaption.v6.synthetic';
    if (kind === 'caption') {
      client.writeCachedParts(key, ['translated']);
      client.writeCaptionJob('YouTubeCaption.Job.v20.synthetic', '11111111-1111-1111-1111-111111111111', 2);
      assert(!store.has('YouTubeCaption.Job.v20.synthetic'));
    } else if (kind === 'lyrics') client.writeCache(key, {provider: 'cloudflare-ai', translations: ['translated']});
    else client.remember(key, {savedAt: epoch});
    assert(!store.has(key));
  }
});

test('malformed lyric cache timestamps are not renewed and absent legacy indices cause no writes', () => {
  let writes = 0;
  const {client, store} = cacheApi('lyrics', {rejectWrite: () => {writes++; return false;}});
  client.clearLegacyCaches();
  assert.equal(writes, 0);
  for (const fields of [{}, {savedAt: epoch}, {savedAt: null, expiresAt: epoch + 1}, {savedAt: epoch, expiresAt: null}]) {
    const key = 'YouTubeLyrics.v6.invalid';
    store.set(key, JSON.stringify({...fields, provider: 'cloudflare-ai', translations: ['translated']}));
    assert.equal(client.readCache(key, 1), null);
    assert(!store.has(key));
  }
});

test('request guards handle header casing, broken config and truncated protobuf with one completion', async () => {
  const file = 'Rewrite/Youtube/youtube.request.js', url = 'https://r1---sn-test.googlevideo.com/initplayback?ack=1';
  for (const name of ['User-Agent', 'user-agent', 'USER-AGENT']) {
    const result = await run(file, {argument: '{}', request: {url, headers: {[name]: 'com.google.ios.youtube/21'}, body: new Uint8Array()}});
    assert.equal(result.done.length, 1);
    assert.equal(result.done[0].response.status, 200, 'known no-key client retains the existing player fallback');
  }
  const missing = await run(file, {argument: '{}', request: {url, headers: {}}});
  assert.deepEqual(Object.keys(missing.done[0]), []);
  for (const config of ['{', '[]', 'null', 'false']) {
    const store = new Map([['YouTubeConfig', config], ['private-setting', 'keep']]);
    const result = await run(file, {argument: '{}', store, request: {url, headers: {'User-Agent': 'youtube/21'}}});
    assert.equal(result.done.length, 1);
    assert.deepEqual(JSON.parse(store.get('YouTubeConfig')), {});
    assert.equal(store.get('private-setting'), 'keep');
  }
  const config = JSON.stringify({youtube: {clientKey: 'a', encryptKey: 'YQ=='}});
  const malformed = await run(file, {argument: '{}', store: new Map([['YouTubeConfig', config]]),
    request: {url, headers: {'User-Agent': 'youtube/21'}, body: new Uint8Array([255])}});
  assert.equal(malformed.done.length, 1);
  assert.deepEqual(Object.keys(malformed.done[0]), []);
  assert.equal(malformed.store.get('YouTubeConfig'), config);
});
