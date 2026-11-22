const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// All I/O is synthetic. Timers advance a virtual clock rather than waiting.
async function run(file, options = {}) {
  const store = options.store || new Map(), timers = new Map();
  const done = [], requests = [], apiCalls = [], writes = [], logs = [], notifications = [];
  const base = options.now ?? Date.parse('2026-11-02T12:00:00+08:00');
  let elapsed = 0, next = 0;
  function timer(fn, ms = 0) { const id = ++next; timers.set(id, {at: elapsed + ms, fn}); return id; }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [base + elapsed])); }
    static now() { return base + elapsed; }
  }
  const context = {
    Date: Clock, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, atob, btoa,
    console: {log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')), warn() {}},
    $environment: {'surge-version': '5.23.0', system: 'iOS'}, $script: {startTime: base / 1000},
    $argument: options.argument || '', $request: options.request || {url: 'https://example.test/', headers: {}, method: 'GET'},
    $persistentStore: {read: key => store.get(key) ?? null, write(value, key) {
      writes.push({key, value}); value === null ? store.delete(key) : store.set(key, value); return true;
    }},
    $surge: {logbook() {}}, $utils: {geoip: () => 'JP', ipaso: () => 'AS64500 Synthetic Provider',
      ungzip: bytes => new Uint8Array(require('node:zlib').gunzipSync(bytes)),
      gzip: bytes => new Uint8Array(require('node:zlib').gzipSync(bytes)), ...options.utils},
    $notification: {post: (...args) => notifications.push(args)},
    $httpAPI(method, endpoint, body, callback) {
      apiCalls.push({method, endpoint, body});
      const reply = options.api?.(method, endpoint, body) || {};
      if (!reply.hang) timer(() => callback(reply.value ?? reply), reply.delay || 0);
    },
    $httpClient: Object.fromEntries(['get', 'post', 'head'].map(method => [method, (input, callback) => {
      const request = typeof input === 'string' ? {url: input} : {...input};
      requests.push({method, ...request});
      const reply = options.http?.(method, request) || {status: 200, body: '{}'};
      if (!reply.hang) timer(() => callback(reply.error || null,
        {status: reply.status ?? 200, headers: reply.headers || {}}, reply.body ?? ''), reply.delay || 0);
    }])),
    setTimeout: timer, clearTimeout: id => timers.delete(id),
    fetch() { throw Error('Tests must not make live requests'); },
    $done(value) { done.push(value); }
  };
  if (!Object.hasOwn(options, 'argument')) delete context.$argument;
  if (Object.hasOwn(options, 'response')) context.$response = options.response;
  if (options.globals) Object.assign(context, options.globals);
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8'), context, {filename: file, timeout: 3000});
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await flush();
  for (let step = 0; step < 10000 && timers.size && (!done.length || options.lateCallbacks); step++) {
    const [id, item] = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    timers.delete(id); elapsed = item.at; item.fn(); await flush();
  }
  return {elapsed, done, requests, apiCalls, writes, store, logs, notifications};
}
module.exports = {run};
