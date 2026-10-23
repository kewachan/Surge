const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'ctm-usage.js'), 'utf8');
const moduleText = fs.readFileSync(path.join(__dirname, 'CTMUsage.sgmodule'), 'utf8');
const endpoint = 'https://www.ctm.net/crm_api/crm-cluster-server/p/by/home/user/infoV2';
const sample = {totalBalance: '2048', availableBalance: '512', usedBalance: '1536',
  isUnlimited: false, dataUnit: 'MB', categoryType: 'SPEED_DATA'};
const payload = usage => JSON.stringify({code: '10000000', data: {usageVO: usage}});

// A syntax guard and substitution harness, not the native Surge parser.
function moduleDefaults(declaration) {
  const values = {};
  for (const field of declaration.split(',')) {
    const match = /^([A-Za-z0-9_]+)(?::(.+))?$/.exec(field);
    assert(match, 'module arguments must not declare an empty colon default');
    assert(!Object.hasOwn(values, match[1]), 'duplicate module argument');
    values[match[1]] = match[2] ?? '';
  }
  return values;
}

function configuredArgument(overrides = {}) {
  const defaults = moduleDefaults(moduleText.match(/^#!arguments=(.*)$/m)[1]);
  const values = {...defaults, ...overrides};
  const template = moduleText.match(/,argument="([^"]*)"/)[1];
  return template.replace(/\{\{\{([A-Za-z0-9_]+)\}\}\}/g, (_, name) => {
    assert(Object.hasOwn(values, name), 'undeclared module argument');
    return values[name];
  });
}

async function run(options = {}) {
  const requests = [], logs = [];
  let doneCount = 0;
  const output = await new Promise((resolve, reject) => {
    const context = {
      $argument: options.argument ?? 'token=test-token&timeout=8',
      $trigger: options.trigger || 'auto-interval',
      $input: {purpose: 'panel'},
      $httpClient: {get(request, callback) {
        requests.push(request);
        if (options.respond) { options.respond(request, callback); return; }
        callback(options.error ?? null, {status: options.status ?? 200}, options.body ?? payload(sample));
      }},
      $persistentStore: {read() { throw Error('Must not persist credentials or usage'); }, write() { throw Error('Must not persist credentials or usage'); }},
      $done(result) { doneCount++; resolve(result); },
      console: {log(...values) { logs.push(values.join(' ')); }}
    };
    try { vm.runInNewContext(source, context, {timeout: 1000}); } catch (error) { reject(error); }
  });
  await Promise.resolve();
  assert.equal(doneCount, 1);
  assert.equal(logs.length, 0, 'never log a token, raw account response or network error');
  return {output, requests};
}

test('automatic and manual refresh fetch once, with only the token, and render a usage bar', async () => {
  for (const trigger of ['auto-interval', 'button']) {
    const {output, requests} = await run({trigger});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, endpoint);
    assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
    assert.equal(Object.keys(requests[0].headers).length, 2);
    assert.equal(requests[0]['auto-redirect'], false);
    assert.equal(requests[0]['auto-cookie'], false);
    assert.equal(output.title, 'CTM Usage Info');
    assert(output.content.includes('🟩'.repeat(8) + '⬜'.repeat(2) + ' 75%'));
    assert(output.content.includes('已用 1.5 GB · 全速剩餘 512 MB'));
    assert(output.content.includes('全速配額 2 GB'));
    assert(output.content.includes('澳門時間'));
    assert(!JSON.stringify(output).includes('test-token'));
  }
});

test('unlimited data above the full-speed cap has a full bar, not negative remaining data', async () => {
  const {output} = await run({body: payload({...sample, usedBalance: '3072', availableBalance: '0', isUnlimited: true})});
  assert(output.content.includes('🟧'.repeat(10) + ' 100%'));
  assert(output.content.includes('已用 3 GB · 全速剩餘 0 MB'));
  assert(output.content.includes('無限數據'));
  assert.equal(output['icon-color'], '#FF9500');
});

test('the bar uses CTM remaining balance and handles absent quota honestly', async () => {
  const {output} = await run({body: payload({...sample, usedBalance: '3072', availableBalance: '1024'})});
  assert(output.content.includes('50%'));
  for (const totalBalance of [null, '0']) {
    const {output} = await run({body: payload({...sample, totalBalance, isUnlimited: true})});
    assert(output.content.includes('配額未提供'));
    assert(!output.content.includes('100%'));
    assert(!output.content.includes('已用完'));
  }
});

test('tokens accept Bearer prefixes and encoding; missing, invalid or injected values never reach CTM', async () => {
  for (const argument of ['token=Bearer test-token', 'token=Bearer%20test-token']) {
    const {requests} = await run({argument});
    assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
  }
  for (const argument of ['', 'token=', 'token=paste-token-here', 'token=Bearer%20', 'token=bad%0D%0AInjected%3Avalue', 'token=%ZZ', 'token=bad token']) {
    const {output, requests} = await run({argument});
    assert.equal(requests.length, 0);
    assert(['info', 'error'].includes(output.style));
    assert(!output.content.includes('0 MB'));
  }
});

test('network, authentication, redirects and broken responses do not masquerade as zero usage', async () => {
  for (const options of [{error: 'private-token reflected by network'}, {status: 401}, {status: 403}, {status: 302},
    {status: 500}, {body: 'private-token not JSON'}, {body: 'null'}, {body: '{"code":"expired","message":"private-token"}'},
    {body: '{"code":"10000000","data":{}}'}]) {
    const {output, requests} = await run(options);
    assert.equal(requests.length, 1, 'no automatic retries with account credentials');
    assert.equal(output.style, 'error');
    assert(!output.content.includes('0 MB'));
    assert(!output.content.includes('private-token'));
    assert(!output.content.includes('🟩'));
  }
});

test('missing, negative or nonnumeric usage and unsupported units fail closed; valid zero is retained', async () => {
  for (const usage of [{...sample, usedBalance: null}, {...sample, usedBalance: ''}, {...sample, usedBalance: -1},
    {...sample, usedBalance: 'NaN'}, {...sample, usedBalance: 'Infinity'}, {...sample, usedBalance: true},
    {...sample, availableBalance: null}, {...sample, totalBalance: -1}, {...sample, dataUnit: 'MIN'}]) {
    assert.equal((await run({body: payload(usage)})).output.style, 'error');
  }
  const {output} = await run({body: payload({...sample, usedBalance: 0, availableBalance: '2048'})});
  assert(output.content.includes('⬜'.repeat(10) + ' 0%'));
  assert(output.content.includes('已用 0 MB'));
});

test('timeout is bounded and module automatically refreshes on opening without MITM or a background timer', async () => {
  for (const [value, expected] of [['1000', 15], ['-1', 8], ['invalid', 8], ['3', 3]]) {
    assert.equal((await run({argument: 'token=test-token&timeout=' + value})).requests[0].timeout, expected);
  }
  assert(moduleText.includes('#!arguments=token:paste-token-here,update_interval:1'));
  assert(moduleText.includes('update_interval:1'));
  assert(moduleText.includes('update-interval={{{update_interval}}}'));
  assert(moduleText.includes('type=generic,timeout=20'));
  assert(moduleText.includes('#!name=CTM Usage Info\n'));
  assert(moduleText.includes('script-name=CTM Usage Info,'));
  assert(moduleText.includes('ctm-usage.js?v=1.0.2'));
  assert(!moduleText.includes('[MITM]'));
  assert(!moduleText.includes('type=cron'));
  assert(!moduleText.includes('type=http-response'));
});

test('module defaults are valid, descriptions are English, and a placeholder never reaches CTM', async () => {
  assert.throws(() => moduleDefaults('token:,update_interval:1'), /empty colon default/);
  assert.deepEqual(moduleDefaults('token:paste-token-here,update_interval:1,timeout:8'),
    {token: 'paste-token-here', update_interval: '1', timeout: '8'});
  assert(!/\p{Script=Han}/u.test(moduleText), 'all module descriptions and setup instructions are English');
  for (const overrides of [{}, {token: ''}, {token: 'Bearer paste-token-here'}]) {
    const {output, requests} = await run({argument: configuredArgument(overrides)});
    assert.equal(requests.length, 0, 'an unconfigured module must never query CTM');
    assert.equal(output.style, 'info');
    assert(!output.content.includes('paste-token-here'));
  }
  for (const token of ['test-token', 'Bearer test-token']) {
    const {requests} = await run({argument: configuredArgument({token})});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
    assert.equal(requests[0].timeout, 8);
  }
});

test('private HAR replay matches the screenshot without putting account data into fixtures', {skip: !process.env.CTM_HAR_PATH}, async () => {
  const entries = JSON.parse(fs.readFileSync(process.env.CTM_HAR_PATH, 'utf8')).log.entries;
  const entry = entries.find(entry => entry.request.url === endpoint && entry.response?.status === 200);
  assert(entry, 'usage reply must exist');
  const body = entry.response.content.encoding === 'base64' ? Buffer.from(entry.response.content.text, 'base64').toString('utf8') : entry.response.content.text;
  const {output} = await run({body});
  assert(output.content.includes('已用 62.1 GB · 全速剩餘 0 MB'));
  assert(output.content.includes('100%'));
  assert(output.content.includes('無限數據'));
});
