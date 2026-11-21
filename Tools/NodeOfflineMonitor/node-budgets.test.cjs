const {test} = require('node:test');
const assert = require('node:assert/strict');
const {run} = require('../Testing/surge-harness.cjs');
const file = 'Tools/NodeOfflineMonitor/node-offline-monitor.js';
const key = 'node_offline_monitor_state_v1', leaseKey = 'node_offline_monitor_lease_v1';
const now = Date.parse('2026-11-02T12:00:00+08:00');
function api(nodes, available = nodes) {
  return (_method, endpoint) => {
    if (endpoint === 'v1/profiles/current') return {profile: ''};
    if (endpoint === 'v1/policies') return {policies: nodes};
    if (endpoint === 'v1/policy_groups') return {groups: []};
    return available === null ? {unknown: true} : {available};
  };
}

test('large fallback outages and recoveries rotate complete five-check batches without starving later nodes', async () => {
  const nodes = Array.from({length: 80}, (_, i) => 'Node ' + String(i).padStart(3, '0'));
  const store = new Map();
  for (let round = 0; round < 2; round++) {
    const result = await run(file, {store, now: now + round * 900000, api: api(nodes, null),
      http: (_method, request) => ({error: 'timeout', delay: request.timeout * 1000}), lateCallbacks: true});
    const state = JSON.parse(store.get(key));
    assert.equal(result.done.length, 1);
    assert(result.elapsed < 170000);
    // On the second batch only the 32 newly failing nodes need four retries.
    assert.equal(result.requests.length, 48 + (round ? 32 : 48) * 4);
    assert.equal(state.checkedPolicies.length, 48);
    assert.equal(state.offline.length, round ? 80 : 48);
    assert.equal(state.unknown.length, round ? 0 : 32);
    assert.equal(result.notifications[0][0], 'Proxy Nodes Offline');
    assert.equal(result.apiCalls.filter(call => call.endpoint === 'v1/policies/test').length, 1);
    assert(!store.get(leaseKey));
  }
  for (let round = 0; round < 2; round++) {
    const result = await run(file, {store, now: now + (round + 2) * 900000, api: api(nodes, null), http: () => ({status: 204})});
    const state = JSON.parse(store.get(key));
    assert.equal(result.notifications[0][0], 'Proxy Nodes Resumed');
    assert.equal(state.offline.length, round ? 0 : 32);
    assert.equal(state.unknown.length, 0);
  }
});

test('the 48/49-node boundary and larger fallback batches finish inside the existing budget', async () => {
  for (const count of [48, 49, 64]) {
    const nodes = Array.from({length: count}, (_, i) => 'Node ' + String(i).padStart(3, '0'));
    const result = await run(file, {api: api(nodes, null),
      http: (_method, request) => ({error: 'timeout', delay: request.timeout * 1000})});
    const state = JSON.parse(result.store.get(key));
    assert.equal(result.elapsed, 140000);
    assert.equal(state.offline.length, 48);
    assert.equal(state.unknown.length, count - 48);
    assert.equal(state.lastError, '');
  }
});

test('switching from native results to a partial fallback never confirms untested candidates', async () => {
  const nodes = Array.from({length: 80}, (_, i) => 'Node ' + String(i).padStart(3, '0'));
  const normal = api(nodes), store = new Map(); let calls = 0;
  const result = await run(file, {store, api: (method, endpoint, body) => endpoint === 'v1/policies/test'
    ? (++calls === 1 ? {available: []} : {unknown: true}) : normal(method, endpoint, body),
    http: (_method, request) => ({error: 'timeout', delay: request.timeout * 1000})});
  const state = JSON.parse(store.get(key));
  assert.equal(calls, 2);
  assert.equal(state.offline.length, 48);
  assert.equal(state.unknown.length, 32);
  assert.equal(state.checkedPolicies.length, 48);
  assert(result.elapsed < 170000);
});

test('an active run skips duplicate discovery; stale leases allow recovery', async () => {
  for (const active of [true, false]) {
    const store = new Map([[leaseKey, JSON.stringify({owner: 'other', expiresAt: now + (active ? 60000 : -1)})]]);
    const result = await run(file, {store, now, api: api(['Node A'])});
    assert.equal(result.apiCalls.length === 0, active);
    assert.equal(result.done.length, 1);
    if (active) assert.equal(JSON.parse(store.get(leaseKey)).owner, 'other');
    else assert(!store.get(leaseKey));
  }
});

test('object policies exclude custom direct/reject types just like array policies', async () => {
  const result = await run(file, {api: api({NodeA: {type: 'ss'}, HomeDirect: {type: 'direct'}, GuardReject: {type: 'reject'}}, ['NodeA'])});
  const names = result.apiCalls.find(call => call.endpoint === 'v1/policies/test').body.policy_names;
  assert.deepEqual(Array.from(names), ['NodeA']);
  assert.equal(result.notifications.length, 0);
});

test('the new URL argument preserves queries without overriding maintenance options', async () => {
  const url = 'https://example.test/probe?x=a%26b&v=2&maintenance_start=00:00#keep';
  const result = await run(file, {argument: 'version=2&maintenance_start=&maintenance_end_time=&test_url=' + url, api: api(['Node A'])});
  assert.equal(result.apiCalls.find(call => call.endpoint === 'v1/policies/test').body.url, url);
  const legacy = await run(file, {argument: `test_url=${url}&maintenance_start=&maintenance_end_time=`, api: api(['Node A'])});
  assert.equal(legacy.apiCalls.find(call => call.endpoint === 'v1/policies/test').body.url, url);
});

test('a hung native API is bounded and releases only its own run lease', async () => {
  const result = await run(file, {api: () => ({hang: true})});
  assert.equal(result.elapsed, 170000);
  assert.equal(result.done.length, 1);
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0][0], 'Proxy Node Monitor Failed');
  assert.equal(JSON.parse(result.store.get(key)).checkedAt, 0);
  assert(JSON.parse(result.store.get(key)).lastError.includes('time budget exhausted'));
  assert(!result.store.get(leaseKey));
});

test('invalid explicit and profile test URLs cannot become node outages', async () => {
  const previous = JSON.stringify({version: 1, policies: ['A', 'B'], offline: ['A'], checkedAt: 1});
  for (const value of ['not-a-url', 'ftp://example.test', 'https://', 'https://example.test /probe', '//example.test']) {
    for (const fromProfile of [false, true]) {
      const normalApi = api(['A', 'B'], null);
      const result = await run(file, {store: new Map([[key, previous]]),
        argument: fromProfile ? '' : 'version=2&maintenance_start=&maintenance_end_time=&test_url=' + value,
        api: (method, endpoint, body) => fromProfile && endpoint === 'v1/profiles/current'
          ? {profile: '[General]\nproxy-test-url = ' + value} : normalApi(method, endpoint, body)});
      const state = JSON.parse(result.store.get(key));
      assert.deepEqual(state.offline, ['A']);
      assert.equal(state.checkedAt, 1);
      assert.equal(result.requests.length, 0);
      assert(!result.apiCalls.some(call => call.endpoint === 'v1/policies/test'));
      assert.equal(result.notifications[0][0], 'Proxy Node Monitor Failed');
    }
  }
});

test('missing and pending native map values are probed before they can be classified offline', async () => {
  for (const missing of [undefined, {status: 'pending'}, {}, {error: 'permission denied'}]) {
    const normalApi = api(['A', 'B', 'C']);
    const result = await run(file, {api: (method, endpoint, body) => endpoint === 'v1/policies/test'
      ? {results: {A: {latency: 20}, ...(missing ? {B: missing} : {}), C: {available: false}}}
      : normalApi(method, endpoint, body),
      http: (_method, request) => request.policy === 'C' ? {error: 'timeout'} : {status: 204}});
    assert.deepEqual(JSON.parse(result.store.get(key)).offline, ['C']);
    assert.equal(result.requests.filter(request => request.policy === 'B').length, 1);
    assert.equal(result.requests.filter(request => request.policy === 'C').length, 5);
  }
});

test('a rejected probe policy preserves every node state even when other policies respond', async () => {
  const previous = JSON.stringify({version: 1, policies: ['A', 'B'], offline: ['A'], checkedAt: 1});
  const result = await run(file, {store: new Map([[key, previous]]), api: api(['A', 'B'], null), lateCallbacks: true,
    http: (_method, request) => request.policy === 'A' ? {error: 'Invalid policy: not found'} : {status: 204}});
  assert.equal(result.done.length, 1);
  assert.deepEqual(JSON.parse(result.store.get(key)).offline, ['A']);
  assert.equal(JSON.parse(result.store.get(key)).checkedAt, 1);
  assert.equal(result.notifications[0][0], 'Proxy Node Monitor Failed');
});

test('deadline failure is deduplicated and late callbacks cannot overwrite preserved state', async () => {
  const store = new Map([[key, JSON.stringify({version: 1, policies: ['A'], offline: ['A'], checkedAt: 1})]]);
  for (let i = 0; i < 2; i++) {
    const result = await run(file, {store, now: now + i * 900000, api: () => ({delay: 200000}), lateCallbacks: true});
    assert.equal(result.done.length, 1);
    assert.equal(result.notifications.length, i ? 0 : 1);
    assert.deepEqual(JSON.parse(store.get(key)).offline, ['A']);
    assert.equal(JSON.parse(store.get(key)).checkedAt, 1);
  }
});

test('corrupt leases can recover, but an overtaken run cannot overwrite state or the new lease', async () => {
  const corrupt = await run(file, {store: new Map([[leaseKey, 'bad JSON']]), api: api(['Node A'])});
  assert(corrupt.apiCalls.length > 0);
  assert(!corrupt.store.get(leaseKey));
  const previous = JSON.stringify({version: 1, policies: ['Node A'], offline: [], checkedAt: 1});
  const store = new Map([[key, previous]]);
  const nextLease = JSON.stringify({owner: 'next run', expiresAt: now + 100000});
  const normal = api(['Node A']);
  const result = await run(file, {store, api: (method, endpoint, body) => {
    if (endpoint === 'v1/policies/test') store.set(leaseKey, nextLease);
    return normal(method, endpoint, body);
  }});
  assert.equal(result.notifications.length, 0);
  assert.equal(store.get(key), previous);
  assert.equal(store.get(leaseKey), nextLease);
});
