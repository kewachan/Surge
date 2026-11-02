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

test('fallback deadline preserves all previous monitoring state and never invents an outage', async () => {
  const previous = JSON.stringify({version: 1, policies: ['old'], offline: ['old'], checkedAt: 1, lastError: ''});
  const store = new Map([[key, previous]]);
  const result = await run(file, {store, api: api(Array.from({length: 80}, (_, i) => 'Node ' + i), null),
    http: (_method, request) => ({error: 'timeout', delay: request.timeout * 1000}), lateCallbacks: true});
  assert.equal(result.done.length, 1);
  assert(result.elapsed <= 170000);
  assert.equal(store.get(key), previous);
  assert.equal(result.notifications.length, 0);
  assert(!store.get(leaseKey));
  assert(result.requests.length < 400);
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
  assert.equal(result.notifications.length, 0);
  assert(!result.store.get(leaseKey));
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
