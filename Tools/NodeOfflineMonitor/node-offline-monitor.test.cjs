const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const script = fs.readFileSync(path.join(__dirname, 'node-offline-monitor.js'), 'utf8');
const moduleText = fs.readFileSync(path.join(__dirname, 'NodeOfflineMonitor.sgmodule'), 'utf8');
const key = 'node_offline_monitor_state_v1';
const initialState = () => JSON.stringify({version: 1, policies: ['Node A', 'Node B'], offline: [], checkedAt: 1, lastError: ''});

function intervalSchedule(minutes) {
  const rendered = moduleText.replaceAll('{{{Check Every Min}}}', String(minutes));
  return /cronexp="([^"]+)"/.exec(rendered)[1];
}

function fireTimes(cron, start, durationMinutes) {
  const fields = cron.split(/\s+/);
  assert.equal(fields.length, 5);
  assert.deepEqual(fields.slice(1), ['*', '*', '*', '*']);
  const step = /^\*\/(\d+)$/.exec(fields[0]);
  assert(step);
  const minutes = Number(step[1]);
  assert(minutes >= 1 && minutes <= 59);
  const first = new Date(start).getTime();
  return Array.from({length: durationMinutes + 1}, (_, index) => new Date(first + index * 60000))
    .filter(time => time.getMinutes() % minutes === 0);
}

async function execute(input = {}) {
  const store = input.store || new Map();
  const calls = [], probes = [], writes = [], notifications = [], logs = [], timers = new Set();
  const nodes = input.nodes || ['Node A', 'Node B'];
  const currentTime = () => typeof input.now === 'function' ? input.now() : (input.now || '2026-10-26T12:00:00');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime()])); }
    static now() { return new Date(currentTime()).getTime(); }
  }
  let doneCount = 0;
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Monitor did not finish')), 1000);
    timers.add(deadline);
    const callback = fn => queueMicrotask(() => { try { fn(); } catch (error) { reject(error); } });
    const context = {
      Date: Clock, URL, console: {log: value => logs.push(String(value))},
      $argument: new URLSearchParams(input.argument || {}).toString(),
      $surge: {logbook() {}},
      $persistentStore: {
        read: name => store.get(name) || '',
        write: (value, name) => { writes.push([name, value]); store.set(name, value); return true; }
      },
      $notification: {post: (...args) => notifications.push(args)},
      $httpAPI: (method, endpoint, body, cb) => {
        calls.push({method, endpoint, body});
        callback(() => {
          if (input.api) return input.api(method, endpoint, body, cb);
          if (endpoint === 'v1/profiles/current') return cb({profile: ''});
          if (endpoint === 'v1/policies') return cb({policies: ['DIRECT', 'REJECT', 'Japan', ...nodes]});
          if (endpoint === 'v1/policy_groups') return cb({groups: ['Japan']});
          if (endpoint === 'v1/policies/test') {
            if (input.fallback) return cb({unknown: true});
            return cb({available: (input.available || nodes).filter(name => body.policy_names.includes(name))});
          }
          throw new Error('Unexpected API endpoint: ' + endpoint);
        });
      },
      $httpClient: {head: (options, cb) => {
        probes.push(options);
        callback(() => {
          if (input.http) return input.http(options, cb);
          cb(null, {status: 204}, '');
        });
      }},
      clearTimeout,
      setTimeout: (fn, delay) => {
        assert([5000, 170000].includes(delay), 'Keep the confirmation delay and bounded run deadline');
        if (delay === 5000 && input.beforeRetry) input.beforeRetry();
        const timer = setTimeout(() => { try { fn(); } catch (error) { reject(error); } }, delay === 5000 ? 1 : delay);
        timers.add(timer);
        return timer;
      },
      $done: () => { doneCount++; resolve(); }
    };
    if (Object.hasOwn(input, 'cronexp')) context.$cronexp = input.cronexp;
    if (Object.hasOwn(input, 'trigger')) context.$trigger = input.trigger;
    try { new vm.Script(script).runInNewContext(context, {timeout: 500}); } catch (error) { reject(error); }
  }).finally(() => { for (const timer of timers) clearTimeout(timer); });
  assert.equal(doneCount, 1);
  return {store, calls, probes, writes: writes.filter(([name]) => name !== 'node_offline_monitor_lease_v1'), notifications, logs};
}

test('module declares two optional maintenance times without malformed empty defaults', () => {
  const declaration = /^#!arguments=(.+)$/m.exec(moduleText)[1];
  const names = declaration.split(',').map(part => part.split(':', 1)[0]);
  assert.deepEqual(names, ['Check Every Min', 'Test URL', 'Wake System', 'Pause From', 'Pause Until']);
  assert(names.every(name => /^[A-Z][A-Za-z0-9]*(?: [A-Za-z][A-Za-z0-9]*)*$/.test(name)));
  assert(declaration.startsWith('Check Every Min:15,'));
  const supported = Array.from({length: 59}, (_, index) => index + 1).filter(minutes => 60 % minutes === 0);
  assert(moduleText.includes('Use ' + supported.join(', ') + ' minutes (default: 15). Other values skip automatic checks.'));
  assert(!moduleText.includes('1–59'));
  for (const minutes of supported.map(String)) {
    const rendered = moduleText.replaceAll('{{{Check Every Min}}}', minutes);
    const cron = /cronexp="([^"]+)"/.exec(rendered)[1];
    assert.equal(cron, '*/' + minutes + ' * * * *');
    assert.equal(cron.split(/\s+/).length, 5);
  }
  assert(declaration.endsWith(',Pause From,Pause Until'));
  for (const match of moduleText.matchAll(/\{\{\{([^}]+)\}\}\}/g)) assert(names.includes(match[1]));
  assert(!moduleText.includes('maintenance_enabled'));
  assert(!moduleText.includes('maintenance_utc_offset'));
  assert(moduleText.includes('ability=http-client-policy'));
  assert(moduleText.includes('node-offline-monitor.js?v=1.10.0'));
  assert(script.includes('Node Offline Monitor for Surge — v1.10.0'));
});

test('maintenance skips all Surge APIs and probes and preserves stored state without notifications', async () => {
  const previous = initialState();
  const store = new Map([[key, previous]]);
  const result = await execute({store, now: '2026-10-26T04:30:00', argument: {maintenance_start: '04:25', maintenance_end_time: '05:15'}});
  assert.equal(result.calls.length, 0);
  assert.equal(result.probes.length, 0);
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
  assert.equal(store.get(key), previous);
  assert(result.logs.some(line => line.includes('node checks skipped')));
});

test('blank, missing, invalid or equal times leave monitoring enabled with no implicit maintenance', async () => {
  for (const argument of [
    {}, {maintenance_start: '', maintenance_end_time: ''}, {maintenance_start: '04:25'},
    {maintenance_end_time: '05:15'}, {maintenance_start: '24:00', maintenance_end_time: '05:15'},
    {maintenance_start: '04:25', maintenance_end_time: '05:60'},
    {maintenance_start: '04:30', maintenance_end_time: '04:30'}
  ]) {
    const result = await execute({argument, now: '2026-10-26T04:30:00'});
    assert.equal(result.calls.filter(call => call.endpoint === 'v1/policies/test').length, 1, JSON.stringify(argument));
    assert.equal(result.writes.length, 1);
    assert.equal(result.notifications.length, 0);
  }
});

test('device-local maintenance includes the start, excludes the end and supports overnight windows', async () => {
  for (const [start, end, time, skipped] of [
    ['04:25', '05:15', '04:24:59', false], ['04:25', '05:15', '04:25:00', true],
    ['04:25', '05:15', '05:14:59', true], ['04:25', '05:15', '05:15:00', false],
    ['23:30', '01:00', '23:29:59', false], ['23:30', '01:00', '23:30:00', true],
    ['23:30', '01:00', '00:30:00', true], ['23:30', '01:00', '01:00:00', false]
  ]) {
    const result = await execute({now: '2026-10-26T' + time, argument: {maintenance_start: start, maintenance_end_time: end}});
    assert.equal(result.calls.length === 0, skipped, [start, end, time].join('/'));
    assert.equal(result.writes.length, skipped ? 0 : 1);
  }
});

test('ordinary outage and recovery still require five confirmations and retain native API routing', async () => {
  const store = new Map();
  const offline = await execute({store, cronexp: intervalSchedule(15), available: ['Node A']});
  assert.equal(offline.calls.filter(call => call.endpoint === 'v1/policies/test').length, 5);
  assert.deepEqual(JSON.parse(store.get(key)).offline, ['Node B']);
  assert.equal(offline.notifications.length, 1);
  assert.equal(offline.notifications[0][0], 'Proxy Nodes Offline');
  assert.equal(offline.probes.length, 0);
  assert(offline.calls.filter(call => call.endpoint === 'v1/policies/test').every(call => !call.body.policy_names.includes('Japan')));
  const resumed = await execute({store, cronexp: intervalSchedule(15)});
  assert.equal(resumed.calls.filter(call => call.endpoint === 'v1/policies/test').length, 5);
  assert.deepEqual(JSON.parse(store.get(key)).offline, []);
  assert.equal(resumed.notifications[0][0], 'Proxy Nodes Resumed');
});

test('entering maintenance during a native test prevents further checks and state changes', async () => {
  let now = '2026-10-26T04:24:59';
  const previous = initialState();
  const store = new Map([[key, previous]]);
  const result = await execute({store, now: () => now, argument: {maintenance_start: '04:25', maintenance_end_time: '05:15'},
    api: (_method, endpoint, _body, cb) => {
      if (endpoint === 'v1/profiles/current') return cb({profile: ''});
      if (endpoint === 'v1/policies') return cb({policies: ['Node A', 'Node B']});
      if (endpoint === 'v1/policy_groups') return cb({groups: []});
      now = '2026-10-26T04:25:00';
      cb({available: []});
    }
  });
  assert.equal(result.calls.filter(call => call.endpoint === 'v1/policies/test').length, 1);
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
  assert.equal(store.get(key), previous);
});

test('fallback probing stops queued nodes when maintenance begins and does not report an outage', async () => {
  let now = '2026-10-26T04:24:59';
  const previous = initialState();
  const store = new Map([[key, previous]]);
  const result = await execute({store, now: () => now, fallback: true,
    nodes: Array.from({length: 18}, (_, index) => 'Node ' + index),
    argument: {maintenance_start: '04:25', maintenance_end_time: '05:15'},
    http: (options, cb) => {
      assert.equal(options.timeout, 8);
      assert(options.policy);
      now = '2026-10-26T04:25:00';
      cb('connection timed out', null, '');
    }
  });
  assert.equal(result.probes.length, 16);
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
  assert.equal(store.get(key), previous);
});

test('a confirmation retry scheduled before maintenance is skipped when its timer fires inside the window', async () => {
  let now = '2026-10-26T04:24:59';
  const previous = initialState();
  const store = new Map([[key, previous]]);
  const result = await execute({store, available: [], now: () => now,
    argument: {maintenance_start: '04:25', maintenance_end_time: '05:15'},
    beforeRetry: () => { now = '2026-10-26T04:25:00'; }
  });
  assert.equal(result.calls.filter(call => call.endpoint === 'v1/policies/test').length, 1);
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
  assert.equal(store.get(key), previous);
});

test('standard minute-step cron resets at each hour, reproducing the reported 7 and 59 minute gaps', () => {
  for (const [minutes, expected] of [[1, [1]], [7, [4, 7]], [15, [15]], [20, [20]], [30, [30]], [59, [1, 59]]]) {
    const times = fireTimes(intervalSchedule(minutes), '2026-10-26T00:00:00', 180);
    const gaps = times.slice(1).map((time, index) => (time - times[index]) / 60000);
    assert.deepEqual([...new Set(gaps)].sort((a, b) => a - b), expected);
  }
});

for (const minutes of [1, 7, 15, 20, 30, 59]) test(minutes + ' minute setting has a constant supported cadence or skips all scheduled probes', async () => {
  const supported = 60 % minutes === 0;
  const cronexp = intervalSchedule(minutes), store = new Map([[key, initialState()]]);
  const previous = store.get(key), checked = [];
  for (const time of fireTimes(cronexp, '2026-10-26T23:30:00', 180)) {
    const result = await execute({store, cronexp, now: time.toISOString()});
    assert.equal(result.notifications.length, 0);
    assert.equal(result.probes.length, 0);
    if (supported) {
      assert.equal(result.calls.filter(call => call.endpoint === 'v1/policies/test').length, 1);
      checked.push(time);
    } else {
      assert.equal(result.calls.length, 0);
      assert.equal(result.writes.length, 0);
      assert.equal(store.get(key), previous);
      assert(result.logs.some(line => line.includes('Unsupported check interval')));
    }
  }
  if (supported) {
    assert(checked.length > 1);
    for (let index = 1; index < checked.length; index++) assert.equal((checked[index] - checked[index - 1]) / 60000, minutes);
  } else {
    assert.equal(checked.length, 0);
  }
});

test('only divisors of 60 in the documented range can start automatic minute-step checks', async () => {
  for (let minutes = 1; minutes <= 59; minutes++) {
    const result = await execute({cronexp: intervalSchedule(minutes)});
    assert.equal(result.calls.some(call => call.endpoint === 'v1/policies/test'), 60 % minutes === 0, String(minutes));
  }
});

test('unsupported or malformed steps preserve offline/error state and never notify or access an API', async () => {
  const previous = JSON.stringify({version: 1, policies: ['Node A', 'Node B'], offline: ['Node B'], checkedAt: 1, lastError: 'preserve'});
  for (const value of [0, 7, 11, 59, 60, -1, '7.5', 'bad']) {
    const store = new Map([[key, previous]]);
    const result = await execute({store, cronexp: intervalSchedule(value)});
    assert.equal(result.calls.length, 0, String(value));
    assert.equal(result.probes.length, 0);
    assert.equal(result.writes.length, 0);
    assert.equal(result.notifications.length, 0);
    assert.equal(store.get(key), previous);
  }
});

test('unsupported configured intervals still allow explicit manual checks', async () => {
  for (const trigger of ['editor', 'http-api', 'intent']) {
    const result = await execute({cronexp: intervalSchedule(7), trigger});
    assert.equal(result.calls.filter(call => call.endpoint === 'v1/policies/test').length, 1);
    assert.equal(result.writes.length, 1);
  }
});

test('standard every-minute, fixed-time and seconds-zero minute schedules remain compatible', async () => {
  for (const cronexp of ['* * * * *', '0 2 * * *', '0 */15 * * * *']) {
    const result = await execute({cronexp});
    assert.equal(result.calls.filter(call => call.endpoint === 'v1/policies/test').length, 1);
  }
  const unsupported = await execute({cronexp: '0 */7 * * * *'});
  assert.equal(unsupported.calls.length, 0);
});

test('supported automatic checks still respect maintenance before all discovery and probes', async () => {
  const previous = initialState(), store = new Map([[key, previous]]);
  const result = await execute({store, cronexp: intervalSchedule(15), now: '2026-10-26T04:30:00',
    argument: {maintenance_start: '04:25', maintenance_end_time: '05:15'}});
  assert.equal(result.calls.length, 0);
  assert.equal(result.probes.length, 0);
  assert.equal(result.writes.length, 0);
  assert.equal(result.notifications.length, 0);
  assert.equal(store.get(key), previous);
});
