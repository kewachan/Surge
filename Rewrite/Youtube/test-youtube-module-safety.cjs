const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {loadClient} = require('./test-youtube-lyrics-order.cjs');
const moduleText = fs.readFileSync(path.join(__dirname, 'YouTube.Enhance.sgmodule'), 'utf8');

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
