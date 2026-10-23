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
  assert.match(output.title, /^Remaining: (?:-- MB|\d+ MB|\d+\.\d (?:GB|TB))$/);
  assert.match(output.content, /^[\x20-\x7E\n]+$/, 'all visible content must be English text without emoji');
  assert.equal(output.icon, 'simcard');
  assert.equal(output['icon-color'], '#6699FF', 'all panel states use Network Info blue');
  return {output, requests};
}

test('invoked automatic and manual refresh fetch once, with remaining in the title and used plus updated below', async () => {
  for (const trigger of ['auto-interval', 'button']) {
    const {output, requests} = await run({trigger});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, endpoint);
    assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
    assert.equal(Object.keys(requests[0].headers).length, 2);
    assert.equal(requests[0]['auto-redirect'], false);
    assert.equal(requests[0]['auto-cookie'], false);
    assert.equal(output.title, 'Remaining: 512 MB');
    const lines = output.content.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'Used: 1.5 GB');
    assert.match(lines[1], /^Updated: \d{2}\/\d{2} \d{2}:\d{2}$/);
    assert(!/remaining/i.test(output.content));
    assert(!JSON.stringify(output).includes('test-token'));
  }
});

test('unlimited data above the full-speed cap keeps the actual used and remaining balances', async () => {
  const {output} = await run({body: payload({...sample, usedBalance: '3072', availableBalance: '0', isUnlimited: true})});
  assert.equal(output.content.split('\n')[0], 'Used: 3.0 GB');
  assert.equal(output.title, 'Remaining: 0 MB');
  assert(!/quota|unlimited|%/i.test(output.content));
});

test('remaining balance comes from CTM and quota is not needed or displayed', async () => {
  const {output} = await run({body: payload({...sample, usedBalance: '3072', availableBalance: '1024'})});
  assert.equal(output.title, 'Remaining: 1.0 GB');
  for (const totalBalance of [undefined, null, '0', -1]) {
    const {output} = await run({body: payload({...sample, totalBalance, isUnlimited: true})});
    assert.equal(output.content.split('\n').length, 2);
    assert(output.content.includes('Used: 1.5 GB'));
    assert.equal(output.title, 'Remaining: 512 MB');
    assert(!/quota|unlimited|%/i.test(output.content));
  }
  const generic = await run({body: payload({...sample, categoryType: 'OTHER_DATA'})});
  assert.equal(generic.output.title, 'Remaining: 512 MB');
});

test('remaining and used share integer MB below 1 GB and one decimal place for GB or TB', async () => {
  for (const [dataUnit, balance, expected] of [
    ['MB', '0', '0 MB'], ['MB', '512.25', '512 MB'], ['MB', '512.5', '513 MB'],
    ['MB', '1023', '1023 MB'], ['MB', '1024', '1.0 GB'], ['GB', '1', '1.0 GB'],
    ['GB', '1.5', '1.5 GB'], ['GB', '1.25', '1.3 GB'], ['TB', '1', '1.0 TB'],
    ['KB', '256', '0 MB'], ['KB', '512', '1 MB'], ['B', '1048576', '1 MB']
  ]) {
    const {output} = await run({body: payload({...sample, dataUnit, availableBalance: balance, usedBalance: balance})});
    assert.equal(output.title, `Remaining: ${expected}`);
    assert.equal(output.content.split('\n')[0], `Used: ${expected}`);
  }
});

test('panel matches Network Info blue with a data-related icon and no bar, quota or timezone label', async () => {
  const networkModule = fs.readFileSync(path.join(__dirname, '../NetworkInfo/NetworkInfo.sgmodule'), 'utf8');
  const networkColor = networkModule.match(/(?:^|,)icon_color:([^,\n]+)/m)[1];
  for (const availableBalance of ['2048', '512', '1', '0']) {
    const {output} = await run({body: payload({...sample, availableBalance})});
    assert.equal(output['icon-color'], networkColor);
    assert.equal(output.icon, 'simcard');
    assert(!/quota|unlimited|Macau|UTC|GMT|%|[()]/i.test(output.content));
    assert.equal(output.content.split('\n').length, 2);
    assert(!/remaining/i.test(output.content));
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
    assert.equal(output.title, 'Remaining: -- MB', 'missing token is not zero remaining');
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
    assert.equal(output.title, 'Remaining: -- MB', 'errors must not claim a remaining balance');
    assert(!output.content.includes('0 MB'));
    assert(!output.content.includes('private-token'));
    assert(!output.content.includes('Used:'));
  }
});

test('missing, negative or nonnumeric usage and unsupported units fail closed; valid zero is retained', async () => {
  for (const usage of [{...sample, usedBalance: null}, {...sample, usedBalance: ''}, {...sample, usedBalance: -1},
    {...sample, usedBalance: 'NaN'}, {...sample, usedBalance: 'Infinity'}, {...sample, usedBalance: true},
    {...sample, availableBalance: null}, {...sample, availableBalance: -1}, {...sample, dataUnit: 'MIN'}]) {
    assert.equal((await run({body: payload(usage)})).output.style, 'error');
  }
  const {output} = await run({body: payload({...sample, usedBalance: 0, availableBalance: '2048'})});
  assert(output.content.includes('Used: 0 MB'));
  assert.equal(output.title, 'Remaining: 2.0 GB');
});

test('timeout is bounded and native panel interval is five minutes without MITM or a background timer', async () => {
  for (const [value, expected] of [['1000', 15], ['-1', 8], ['invalid', 8], ['3', 3]]) {
    assert.equal((await run({argument: 'token=test-token&timeout=' + value})).requests[0].timeout, expected);
  }
  assert(moduleText.includes('#!arguments=token:paste-token-here,timeout:8'));
  assert.match(moduleText, /^CTM Usage Info = .*script-name=CTM Usage Info,update-interval=300$/m);
  assert(!moduleText.includes('update_interval'), 'a saved legacy one-second option cannot override the fixed interval');
  assert(moduleText.includes('type=generic,timeout=20'));
  assert(moduleText.includes('#!name=CTM Usage Info\n'));
  assert(moduleText.includes('script-name=CTM Usage Info,'));
  assert(moduleText.includes('ctm-usage.js?v=1.0.5'));
  assert(moduleText.includes('title="Remaining: -- MB"'));
  assert(!moduleText.includes('[MITM]'));
  assert(!moduleText.includes('type=cron'));
  assert(!moduleText.includes('type=http-response'));
});

test('manual refresh always queries CTM, including repeated taps inside the automatic interval', async () => {
  // Surge owns the cached panel and automatic interval. The script must not
  // throttle a button invocation or add another persistent-store cache.
  const first = await run({trigger: 'button'});
  const second = await run({trigger: 'button', body: payload({...sample, availableBalance: '256'})});
  assert.equal(first.requests.length, 1);
  assert.equal(second.requests.length, 1);
  assert.equal(first.output.title, 'Remaining: 512 MB');
  assert.equal(second.output.title, 'Remaining: 256 MB');
});

test('module defaults are valid, descriptions are English, and a placeholder never reaches CTM', async () => {
  assert.throws(() => moduleDefaults('token:,update_interval:1'), /empty colon default/);
  assert.deepEqual(moduleDefaults(moduleText.match(/^#!arguments=(.*)$/m)[1]),
    {token: 'paste-token-here', timeout: '8'});
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
  const lines = output.content.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Used: 62.1 GB');
  assert.equal(output.title, 'Remaining: 0 MB');
  assert.match(lines[1], /^Updated: \d{2}\/\d{2} \d{2}:\d{2}$/);
});
