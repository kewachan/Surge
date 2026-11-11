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
    const match = /^([^:,\r\n]+)(?::(.+))?$/.exec(field);
    assert(match, 'module arguments must not declare an empty colon default');
    assert(!Object.hasOwn(values, match[1]), 'duplicate module argument');
    values[match[1]] = match[2] ?? '';
  }
  return values;
}

function substitute(template, overrides = {}) {
  const defaults = moduleDefaults(moduleText.match(/^#!arguments=(.*)$/m)[1]);
  const values = {...defaults, ...overrides};
  return template.replace(/\{\{\{([^}]+)\}\}\}/g, (_, name) => {
    assert(Object.hasOwn(values, name), 'undeclared module argument');
    return values[name];
  });
}

function configuredArgument(overrides = {}) {
  return substitute(moduleText.match(/,argument="([^"]*)"/)[1], overrides);
}

function configuredPanel(overrides = {}) {
  return substitute(moduleText.match(/^CTM Usage Info = .*script-name=CTM Usage Info,.*$/m)[0], overrides);
}

async function run(options = {}) {
  const requests = [], logs = [];
  let doneCount = 0;
  const output = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Panel did not complete')), 2000);
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
      $done(result) { doneCount++; clearTimeout(timer); resolve(result); },
      console: {log(...values) { logs.push(values.join(' ')); }}
    };
    try { vm.runInNewContext(source, context, {timeout: 1000}); } catch (error) { clearTimeout(timer); reject(error); }
  });
  await Promise.resolve();
  assert.equal(doneCount, 1);
  assert.equal(logs.length, 0, 'never log a token, raw account response or network error');
  assert.match(output.title, /^Remaining: (?:--|\d+(?:\.\d)?)(?: \+ (?:--|\d+(?:\.\d)?) [=≈] (?:--|\d+(?:\.\d)?))? (?:MB|GB|TB)$/);
  assert.match(output.content, /^[\x20-\x7E\n≈]+$/, 'visible content is English text with the approximation symbol and no emoji');
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
  const networkSource = fs.readFileSync(path.join(__dirname, '../NetworkInfo/network-info.js'), 'utf8');
  const networkColor = networkSource.match(/iconColor:\s*"([^"]+)"/)[1];
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

test('two valid tokens show compact remaining and used equations with one update time', async () => {
  const {output, requests} = await run({
    argument: configuredArgument({Token: 'first-token', 'Token 2': 'Bearer second-token'}),
    respond(request, callback) {
      const usage = request.headers.Authorization === 'Bearer first-token' ? sample
        : {...sample, usedBalance: '4096', availableBalance: '2048'};
      callback(null, {status: 200}, payload(usage));
    }
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.headers.Authorization), ['Bearer first-token', 'Bearer second-token']);
  assert.equal(output.title, 'Remaining: 0.5 + 2.0 = 2.5 GB');
  assert.match(output.content, /^Used: 1\.5 \+ 4\.0 = 5\.5 GB\nUpdated: \d{2}\/\d{2} \d{2}:\d{2}$/);
  assert(!output.content.includes('Plan 2'));
  for (const request of requests) {
    assert.equal(request.url, endpoint);
    assert.equal(request.timeout, 8);
    assert.equal(request['auto-redirect'], false);
    assert.equal(request['auto-cookie'], false);
    assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Authorization']);
  }
  assert(!JSON.stringify(output).includes('first-token'));
  assert(!JSON.stringify(output).includes('second-token'));
});

test('the requested two-plan example uses units only at the end of each equation', async () => {
  const {output} = await run({
    argument: 'token=first-token&token2=second-token',
    respond(request, callback) {
      const usage = request.headers.Authorization === 'Bearer first-token'
        ? {...sample, dataUnit: 'GB', usedBalance: '16', availableBalance: '44'}
        : {...sample, dataUnit: 'GB', usedBalance: '22.7', availableBalance: '17.3'};
      callback(null, {status: 200}, payload(usage));
    }
  });
  assert.equal(output.title, 'Remaining: 44.0 + 17.3 = 61.3 GB');
  assert.equal(output.content.split('\n')[0], 'Used: 16.0 + 22.7 = 38.7 GB');
  assert.equal(output.content.split('\n').length, 2);
});

test('combined amounts round the original sum once across units and GB or TB boundaries', async () => {
  for (const [leftUnit, left, rightUnit, right, expected] of [
    ['MB', '256', 'MB', '512', '256 + 512 = 768 MB'],
    ['MB', '512', 'GB', '1', '0.5 + 1.0 = 1.5 GB'],
    ['GB', '0', 'GB', '0', '0 + 0 = 0 MB'],
    ['GB', '1.04', 'GB', '1.04', '1.0 + 1.0 ≈ 2.1 GB'],
    ['GB', '1.06', 'GB', '1.06', '1.1 + 1.1 ≈ 2.1 GB'],
    ['MB', '511.6', 'MB', '511.6', '512 + 512 ≈ 1023 MB'],
    ['MB', '512', 'MB', '512', '0.5 + 0.5 = 1.0 GB'],
    ['GB', '0.526', 'GB', '0.526', '0.5 + 0.5 ≈ 1.1 GB'],
    ['GB', '511.96', 'GB', '511.96', '512.0 + 512.0 ≈ 1023.9 GB'],
    ['GB', '512', 'GB', '512', '0.5 + 0.5 = 1.0 TB'],
    ['TB', '0.526', 'TB', '0.526', '0.5 + 0.5 ≈ 1.1 TB'],
    ['TB', '1.04', 'TB', '1.04', '1.0 + 1.0 ≈ 2.1 TB'],
    ['MB', '600', 'GB', '0.456', '0.6 + 0.5 ≈ 1.0 GB'],
    ['MB', '0.49', 'MB', '0.49', '0 + 0 ≈ 1 MB'],
    ['TB', '1', 'GB', '512', '1.0 + 0.5 = 1.5 TB']
  ]) {
    const {output} = await run({
      argument: 'token=first-token&token2=second-token',
      respond(request, callback) {
        const first = request.headers.Authorization === 'Bearer first-token';
        callback(null, {status: 200}, payload({...sample,
          dataUnit: first ? leftUnit : rightUnit,
          usedBalance: first ? left : right,
          availableBalance: first ? left : right}));
      }
    });
    assert.equal(output.title, 'Remaining: ' + expected);
    assert.equal(output.content.split('\n')[0], 'Used: ' + expected);
  }
});

test('only the equation with a rounding difference uses the approximation symbol', async () => {
  const {output} = await run({
    argument: 'token=first-token&token2=second-token',
    respond(request, callback) {
      callback(null, {status: 200}, payload({...sample, dataUnit: 'GB', availableBalance: '1.04',
        usedBalance: request.headers.Authorization === 'Bearer first-token' ? '16' : '22.7'}));
    }
  });
  assert.equal(output.title, 'Remaining: 1.0 + 1.0 ≈ 2.1 GB');
  assert.equal(output.content.split('\n')[0], 'Used: 16.0 + 22.7 = 38.7 GB');
  assert.equal(output.content.split('\n').length, 2);
});

test('an empty or disabled second token makes no extra request or visible plan', async () => {
  for (const second of ['', ' ', '%20', 'none', 'None', '%20none%20']) {
    const {output, requests} = await run({argument: 'token=first-token&token2=' + second + '&timeout=8'});
    assert.equal(requests.length, 1);
    assert.equal(output.title, 'Remaining: 512 MB');
    assert.equal(output.content.split('\n').length, 2);
    assert(!output.content.includes('Plan 2'));
  }
});

test('both plans start concurrently and preserve their order when the second completes first', async () => {
  const pending = [];
  const {output, requests} = await run({
    argument: 'token=first-token&token2=second-token&timeout=15',
    respond(request, callback) {
      pending.push(callback);
      if (pending.length === 2) {
        pending[1](null, {status: 200}, payload({...sample, availableBalance: '4096'}));
        pending[0](null, {status: 200}, payload(sample));
      }
    }
  });
  assert.equal(requests.length, 2, 'the second request starts before the first completes');
  assert(requests.every(request => request.timeout === 15));
  assert.equal(output.title, 'Remaining: 0.5 + 4.0 = 4.5 GB');
  assert(!output.content.includes('Plan 2'));
});

test('an invalid second token cannot block the first plan or reach CTM', async () => {
  for (const second of ['bad%0D%0AInjected%3Avalue', '%ZZ', 'bad token', 'paste-token-here', 'Bearer%20']) {
    const {output, requests} = await run({argument: 'token=first-token&token2=' + second});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.Authorization, 'Bearer first-token');
    assert.equal(output.title, 'Remaining: 512 + -- = -- MB');
    assert(output.content.startsWith('Used: 1.5 + -- = -- GB\nUpdated: '));
    assert.match(output.content, /\nTotal unavailable\. Token 2: (?:Invalid token format|Set your CTM token)/);
    assert(!output.content.includes('Plan 2'));
    assert(!/Injected|paste-token-here|bad token/.test(output.content));
  }
});

test('second-plan network, auth, redirect and usage errors preserve the successful first plan', async () => {
  for (const failure of [
    {error: 'private-second-token'}, {status: 401}, {status: 403}, {status: 302},
    {status: 500}, {body: 'private-second-token invalid JSON'},
    {body: payload({...sample, availableBalance: null})},
    {body: '{"code":"expired","message":"private-second-token"}'}
  ]) {
    const {output, requests} = await run({
      argument: 'token=first-token&token2=second-token',
      respond(request, callback) {
        if (request.headers.Authorization === 'Bearer first-token') callback(null, {status: 200}, payload(sample));
        else callback(failure.error ?? null, {status: failure.status ?? 200}, failure.body ?? payload(sample));
      }
    });
    assert.equal(requests.length, 2, 'each configured plan is queried at most once');
    assert.equal(output.title, 'Remaining: 512 + -- = -- MB');
    assert(output.content.startsWith('Used: 1.5 + -- = -- GB\nUpdated: '));
    const second = output.content.split('\nTotal unavailable. Token 2: ')[1];
    assert(second, 'the failed plan has its own error');
    assert(!/Used:|Remaining: 0 MB|Updated:|private-second-token/.test(second));
  }
});

test('missing, invalid or unauthorized first-plan credentials still allow the second plan', async () => {
  for (const first of ['', '%ZZ', 'bad%0D%0AInjected%3Avalue', 'expired-token']) {
    const {output, requests} = await run({
      argument: 'token=' + first + '&token2=Bearer%20second-token',
      respond(request, callback) {
        if (request.headers.Authorization === 'Bearer expired-token') callback(null, {status: 401}, '');
        else callback(null, {status: 200}, payload({...sample, availableBalance: '3072'}));
      }
    });
    assert.equal(requests.length, first === 'expired-token' ? 2 : 1);
    assert.equal(output.title, 'Remaining: -- + 3.0 = -- GB');
    assert(output.content.startsWith('Used: -- + 1.5 = -- GB\nUpdated: '));
    assert(output.content.includes('\nTotal unavailable. Token: '));
    assert(!output.content.includes('Plan 2'));
    assert(!/Injected|expired-token|second-token/.test(output.content));
  }
});

test('a valid zero balance plus a failed plan leaves the combined total unknown', async () => {
  const {output} = await run({
    argument: 'token=first-token&token2=second-token',
    respond(request, callback) {
      if (request.headers.Authorization === 'Bearer first-token') {
        callback(null, {status: 200}, payload({...sample, usedBalance: '0', availableBalance: '0'}));
      } else callback(null, {status: 401}, '');
    }
  });
  assert.equal(output.title, 'Remaining: 0 + -- = -- MB');
  assert(output.content.startsWith('Used: 0 + -- = -- MB\nUpdated: '));
  assert(output.content.includes('\nTotal unavailable. Token 2: Token expired or unauthorized.'));
  assert(!output.content.includes('≈'));
});

test('two failed plans finish once, expose separate errors and never claim zero balances', async () => {
  const {output, requests} = await run({argument: 'token=first-token&token2=second-token', status: 401});
  assert.equal(requests.length, 2);
  assert.equal(output.title, 'Remaining: -- MB');
  assert.equal(output.style, 'error');
  assert.equal(output.content.split('Token expired or unauthorized.').length - 1, 2);
  assert(output.content.includes('\nToken 2: '));
  assert(!output.content.includes('Plan 2'));
  assert(!/Used:|Remaining: 0 MB|Updated:/.test(output.content));
});

test('automatic and repeated manual refresh query both plans without storing their credentials', async () => {
  for (const trigger of ['auto-interval', 'button', 'button']) {
    const {requests} = await run({trigger, argument: 'token=first-token&token2=second-token'});
    assert.equal(requests.length, 2);
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

test('timeout is bounded and native panel interval defaults to fifteen minutes without MITM or a background timer', async () => {
  for (const [value, expected] of [['1000', 15], ['-1', 8], ['invalid', 8], ['3', 3]]) {
    assert.equal((await run({argument: 'token=test-token&timeout=' + value})).requests[0].timeout, expected);
  }
  assert(moduleText.includes('#!arguments=Token:paste-token-here,Token 2:none,Refresh Interval:900,Timeout:8'));
  assert.match(configuredPanel(), /script-name=CTM Usage Info,update-interval=900$/);
  assert(!moduleText.includes('update_interval'), 'a saved legacy one-second option cannot override the new default');
  assert(moduleText.includes('type=generic,timeout=20'));
  assert(moduleText.includes('#!name=CTM Usage Info\n'));
  assert(moduleText.includes('script-name=CTM Usage Info,'));
  assert(moduleText.includes('ctm-usage.js?v=1.0.9'));
  assert(moduleText.includes('title="Remaining: -- MB"'));
  assert(!moduleText.includes('[MITM]'));
  assert(!moduleText.includes('type=cron'));
  assert(!moduleText.includes('type=http-response'));
});

test('refresh interval is configurable in seconds without reusing the old one-second setting', () => {
  for (const seconds of ['300', '900', '1800', '3600']) {
    assert(configuredPanel({'Refresh Interval': seconds}).endsWith('update-interval=' + seconds));
    assert.equal(configuredArgument({Token: 'test-token', 'Refresh Interval': seconds}), 'token=test-token&token2=none&timeout=8');
  }
  assert(configuredPanel({update_interval: '1'}).endsWith('update-interval=900'));
  assert(configuredPanel({update_interval: '1', 'Refresh Interval': '1800'}).endsWith('update-interval=1800'));
  assert(!configuredPanel().includes('{{{'));
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
    {Token: 'paste-token-here', 'Token 2': 'none', 'Refresh Interval': '900', Timeout: '8'});
  assert(!/\p{Script=Han}/u.test(moduleText), 'all module descriptions and setup instructions are English');
  for (const overrides of [{}, {Token: ''}, {Token: 'Bearer paste-token-here'}]) {
    const {output, requests} = await run({argument: configuredArgument(overrides)});
    assert.equal(requests.length, 0, 'an unconfigured module must never query CTM');
    assert.equal(output.style, 'info');
    assert(!output.content.includes('paste-token-here'));
  }
  for (const token of ['test-token', 'Bearer test-token']) {
    const {requests} = await run({argument: configuredArgument({Token: token})});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
    assert.equal(requests[0].timeout, 8);
  }
});

test('the optional second plan has a nonempty module default and a single-token install keeps the original panel', async () => {
  const defaults = moduleDefaults(moduleText.match(/^#!arguments=(.*)$/m)[1]);
  assert.equal(defaults['Token 2'], 'none', 'an unset module parameter must not suppress the panel during native module application');
  const argument = configuredArgument({Token: 'first-token'});
  assert.equal(argument, 'token=first-token&token2=none&timeout=8');
  const {output, requests} = await run({argument});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.Authorization, 'Bearer first-token');
  assert.equal(output.title, 'Remaining: 512 MB');
  assert.match(output.content, /^Used: 1\.5 GB\nUpdated: \d{2}\/\d{2} \d{2}:\d{2}$/);
  assert(!output.content.includes('Plan 2'));
  assert.match(configuredPanel(), /^CTM Usage Info = title="Remaining: -- MB",content="[^"]+",script-name=CTM Usage Info,update-interval=900$/);
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
