const {test} = require('node:test');
const assert = require('node:assert/strict');
const {run} = require('../Testing/surge-harness.cjs');
const file = 'Tools/NetworkInfo/network-info.js';

test('raw lookup URLs preserve separators, encoded values and fragments', async () => {
  const url = 'https://example.test/ip?text=a%26b&v=2&timeout=999#part';
  const result = await run(file, {argument: 'version=2&timeout=5&retries=0&retry_delay=0&proxy_endpoint=' + url,
    http: () => ({body: '203.0.113.1'})});
  assert.equal(result.requests[0].url, url);
  assert.equal(result.requests[0].timeout, 5);
  assert.equal(result.done.length, 1);
  assert.match(result.done[0].content, /203\.0\.113\.1/);
});

test('legacy arguments and the default endpoint remain compatible', async () => {
  const result = await run(file, {argument: 'proxy_endpoint=https%3A%2F%2Fexample.test%2Fip&timeout=2&retries=0',
    http: () => ({body: '203.0.113.1'})});
  assert.equal(result.requests[0].url, 'https://example.test/ip');
  assert.equal(result.requests[0].timeout, 2);
  const url = 'https://example.test/ip?x=a%26b&v=2';
  const legacy = await run(file, {argument: `proxy_endpoint=${url}&timeout=2&retries=0&retry_delay=1`, http: () => ({body: '203.0.113.1'})});
  assert.equal(legacy.requests[0].url, url);
});

test('maximum retries finish inside 110 seconds without late duplicate completion', async () => {
  const result = await run(file, {argument: 'timeout=30&retries=5&retry_delay=10', lateCallbacks: true,
    http: (_method, request) => ({error: 'timeout', delay: request.timeout * 1000})});
  assert(result.elapsed <= 110000);
  assert.equal(result.done.length, 1);
  assert.equal(result.done[0].style, 'error');
  assert(result.requests.length < 6);
});

test('a missing HTTP callback cannot retain the panel script past its deadline', async () => {
  const result = await run(file, {http: () => ({hang: true})});
  assert.equal(result.elapsed, 110000);
  assert.equal(result.done.length, 1);
  assert.equal(result.done[0].style, 'error');
});
