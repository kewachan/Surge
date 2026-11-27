import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';

// Google search request redirects.
{
const moduleText = fs.readFileSync(new URL('../../../Rewrite/Adrewrite.sgmodule', import.meta.url), 'utf8');
const declaration = moduleText.split('\n').find(line => line.startsWith('google.search.request ='));
const pattern = new RegExp(/pattern=(.*?),engine=/.exec(declaration)[1]);
const scriptSource = fs.readFileSync(new URL('../../../Rewrite/google-search.request.js', import.meta.url), 'utf8');
const compiled = new vm.Script(scriptSource);
function redirect(url, method = 'GET') {
  if (!pattern.test(url)) return url;
  const outputs = [];
  compiled.runInNewContext({$request: {url, method, headers: {}}, $done: result => outputs.push(result)}, {timeout: 1000});
  assert.equal(outputs.length, 1);
  const result = outputs[0];
  if (!result.response) { assert.deepEqual(Object.keys(result), []); return url; }
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers['Cache-Control'], 'no-store');
  return result.response.headers.Location;
}

function permutations(fields) {
  if (fields.length === 0) return [[]];
  return fields.flatMap((field, index) => permutations(fields.filter((_, i) => i !== index))
    .map(rest => [field, ...rest]));
}

const searchUrl = 'https://www.google.com/search?';
const orders = permutations(['client=safari', 'q=C%2B%2B+%E9%A6%99%E6%B8%AF%20%26%20Mac%2520Safari', 'hl=en', 'rls=en-US']);
const queryTail = '&ie=UTF-8&oe=UTF-8&start=20&ei=keep%2Bvalue&oq=raw%2fSlash%2F&filter=0&filter=1';
const fragment = '#results%20here?udm=50&client=keep';
const orderedCases = orders.map(fields => {
  const query = [...fields.slice(0, -1), ...queryTail.slice(1).split('&'), fields.at(-1)];
  return {
    input: searchUrl + query.join('&') + fragment,
    expected: searchUrl + query.filter(field => field !== 'client=safari').join('&')
      + '&gl=hk&safe=off&udm=14' + fragment
  };
});
const reportedCases = [
  { input: searchUrl + 'hl=en&client=safari&q=abc', expected: searchUrl + 'hl=en&q=abc&gl=hk&safe=off&udm=14' },
  { input: searchUrl + 'hl=en&q=abc&client=safari', expected: searchUrl + 'hl=en&q=abc&gl=hk&safe=off&udm=14' }
];
const explicitCases = orders.flatMap(fields => ['udm=0', 'udm=2', 'udm=14', 'udm=50', 'tbm=isch', 'tbm=nws', 'tbm=vid']
  .flatMap(mode => Array.from({ length: fields.length + 1 }, (_, index) => {
    const query = [...fields.slice(0, index), mode, ...fields.slice(index)];
    const input = searchUrl + [...query.slice(0, -1), ...queryTail.slice(1).split('&'), query.at(-1)].join('&') + fragment;
    return { input, expected: input };
  })));
const boundaryCases = [
  'https://www.google.com/search?hl=en&client=safari&q=',
  'https://www.google.com/search?hl=en&q=&client=safari',
  'https://www.google.com/search?hl=en&client=safari&rls=en#q=fragment-only',
  'https://www.google.com/about?hl=en&client=safari&q=test',
  'https://example.com/search?hl=en&client=safari&q=test',
  'https://www.google.com.example.com/search?hl=en&client=safari&q=test'
].map(input => ({ input, expected: input }));
const conflictingQueries = ['client=safari&q=raw%2Btext&gl=tw&safe=active',
  'gl=tw&safe=active&q=raw%2Btext&client=safari',
  'client=safari&client=other&%67l=tw&gl=us&safe=active&q=raw%2Btext&safe=on'];
const conflictCases = conflictingQueries.map(query => ({input: searchUrl + query + '#results%20here',
  expected: searchUrl + 'q=raw%2Btext&gl=hk&safe=off&udm=14#results%20here'}));
const encodedModeCases = ['%75dm=2', '%74bm=nws', 'udm', 'tbm', 'udm=', '%ZZ=broken']
  .map(tail => searchUrl + 'client=safari&q=test&' + tail).map(input => ({input, expected: input}));

test('Safari client-first searches use Hong Kong and retain query data', () => {
  for (const tail of ['q=Mac%20Safari', 'rls=en&q=C%2B%2B%20%26%20Mac&ie=UTF-8&oe=UTF-8&start=10']) {
    const input = 'https://www.google.com/search?client=safari&' + tail + '#results';
    const output = redirect(input), parsed = new URL(output), before = new URL(input);
    assert.equal(parsed.searchParams.get('gl'), 'hk');
    assert.equal(parsed.searchParams.get('safe'), 'off');
    assert.equal(parsed.searchParams.get('udm'), '14');
    assert.equal(parsed.searchParams.has('client'), false);
    for (const [key, value] of before.searchParams) if (key !== 'client') assert.equal(parsed.searchParams.get(key), value);
    assert.equal(parsed.hash, '#results');
    assert.equal(redirect(output), output);
  }
});

test('existing query-first searches retain the same redirect', () => {
  const input = 'https://www.google.com/search?q=Mac%20Safari&client=safari&start=10&ei=keep#results';
  assert.equal(redirect(input), 'https://www.google.com/search?q=Mac%20Safari&start=10&ei=keep&gl=hk&safe=off&udm=14#results');
});

test('explicit image, AI and other search modes are retained without redirects', () => {
  for (const mode of ['udm=2', 'udm=14', 'udm=50', 'tbm=isch', 'tbm=nws']) {
    for (const query of ['client=safari&rls=en&q=test&', 'q=test&client=safari&']) {
      const input = 'https://www.google.com/search?' + query + mode;
      assert.equal(redirect(input), input);
    }
  }
});

test('the existing client-free fallback stays idempotent and preserves parameters', () => {
  const input = 'https://www.google.com/search?ei=keep&q=test&start=10#results';
  const output = redirect(input);
  assert.equal(output, 'https://www.google.com/search?udm=14&ei=keep&q=test&start=10#results');
  assert.equal(redirect(output), output);
});

test('non-search pages, missing queries and unrelated domains are untouched', () => {
  for (const input of ['https://www.google.com/search?client=safari&q=',
    'https://www.google.com/search?client=safari&rls=en',
    'https://www.google.com/about?client=safari&q=test',
    'https://example.com/search?client=safari&q=test']) assert.equal(redirect(input), input);
});

test('reported Safari middle-client and trailing-client searches receive all defaults', () => {
  for (const { input, expected } of reportedCases) assert.equal(redirect(input), expected);
});

test('all 24 Safari parameter orders preserve raw query bytes, pagination, duplicates and fragments', () => {
  assert.equal(orderedCases.length, 24);
  for (const { input, expected } of orderedCases) {
    const output = redirect(input);
    assert.equal(output, expected);
    assert.equal(redirect(output), output);
    assert.deepEqual(new URL(output).searchParams.getAll('filter'), ['0', '1']);
  }
});

test('explicit search modes are untouched in all 840 parameter arrangements', () => {
  assert.equal(explicitCases.length, 840);
  for (const { input, expected } of explicitCases) assert.equal(redirect(input), expected);
});

test('middle-client handling retains the search scope and requires a nonempty query', () => {
  for (const { input, expected } of boundaryCases) assert.equal(redirect(input), expected);
  const input = searchUrl + 'hl=en&q=literal%26client%3Dsafari%26udm%3D50&notclient=safari#client=safari';
  assert.equal(redirect(input), searchUrl + 'udm=14&' + input.slice(searchUrl.length));
});

test('native macOS ICU scope and JavaScriptCore produce the expected redirects without a second redirect', {
  skip: process.platform !== 'darwin'
}, () => {
  const cases = [...reportedCases, ...orderedCases, ...explicitCases, ...boundaryCases, ...conflictCases, ...encodedModeCases];
  const source = 'ObjC.import("Foundation"); const pattern=' + JSON.stringify(pattern.source) + ', cases=' + JSON.stringify(cases)
    + ', scriptSource=' + JSON.stringify(scriptSource) + '; const compileFailures=[], re=$.NSRegularExpression.regularExpressionWithPatternOptionsError($(pattern),0,Ref());'
    + 'if(ObjC.unwrap(re)===undefined)compileFailures.push(0);const execute=new Function("$request","$done",scriptSource);'
    + 'function redirect(input){const range=$.NSMakeRange(0,input.length);'
    + 'if(ObjC.unwrap(re.firstMatchInStringOptionsRange($(input),0,range))===undefined)return input;'
    + 'let result;execute({url:input,method:"GET"},function(value){result=value;});return result&&result.response?result.response.headers.Location:input;}'
    + 'let mismatchCount=0;const examples=[];cases.forEach((c,i)=>{const output=redirect(c.input),again=redirect(output);'
    + 'if(output!==c.expected||again!==output){mismatchCount++;if(examples.length<3)examples.push({index:i,output:output,again:again});}});'
    + 'JSON.stringify({compileFailures:compileFailures,mismatchCount:mismatchCount,examples:examples});';
  const result = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript'], {
    input: source, encoding: 'utf8', timeout: 15000
  }));
  assert.deepEqual(result, { compileFailures: [], mismatchCount: 0, examples: [] });
});

test('Safari defaults replace conflicting and duplicate gl/safe values while preserving other raw fields', () => {
  for (const query of conflictingQueries) {
    const output = redirect(searchUrl + query + '#results%20here');
    const parsed = new URL(output);
    assert.deepEqual(parsed.searchParams.getAll('gl'), ['hk']);
    assert.deepEqual(parsed.searchParams.getAll('safe'), ['off']);
    assert.deepEqual(parsed.searchParams.getAll('udm'), ['14']);
    assert(!parsed.searchParams.has('client'));
    assert(output.includes('q=raw%2Btext'));
    assert(output.endsWith('#results%20here'));
    assert.equal(redirect(output), output);
  }
});

test('encoded and bare explicit modes, non-GET requests and malformed keys preserve the original URL', () => {
  for (const tail of ['%75dm=2', '%74bm=nws', 'udm', 'tbm', 'udm=', '%ZZ=broken']) {
    const input = searchUrl + 'client=safari&q=test&' + tail;
    assert.equal(redirect(input), input);
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS']) {
    const input = searchUrl + 'client=safari&q=test';
    assert.equal(redirect(input, method), input);
  }
  const input = searchUrl + 'client=safari&q=test\r\nX-Injected:value';
  assert.equal(redirect(input), input);
});

test('Wikipedia locale redirects cannot match embedded URLs or lookalike domains', () => {
  const rules = moduleText.split('\n').map(line => /^(\S+) (\S+) 302$/.exec(line))
    .filter(match => match && match[1].includes('wikipedia')).map(match => ({pattern: new RegExp(match[1]), replacement: match[2]}));
  const rewrite = input => {const rule = rules.find(rule => rule.pattern.test(input)); return rule ? input.replace(rule.pattern, rule.replacement) : input;};
  for (const host of ['zh.wikipedia.org', 'zh.m.wikipedia.org']) for (const locale of ['wiki', 'zh-cn', 'zh-hans', 'zh']) {
    const input = `https://${host}/${locale}/Example%20Title?q=a%2Bb#keep`;
    assert.equal(rewrite(input), `https://${host}/zh-hk/Example%20Title?q=a%2Bb#keep`);
  }
  for (const input of ['http://example.test/continue?next=https://zh.wikipedia.org/wiki/Example',
    'http://zhXwikipedia.org/wiki/Example', 'https://zh.wikipedia.org.example.test/wiki/Example',
    'https://zh.wikipedia.org/zh-hk/Example']) assert.equal(rewrite(input), input);
});

 test('existing Google ad blocks and MITM coverage remain in place', () => {
  const section = moduleText.split('#Google\n')[1].split('\n\n')[0];
  assert.equal(section.split('\n').filter(line => line.endsWith(' - reject')).length, 3);
  assert(moduleText.includes('google.com, *.google.com,'));
});
}

// Google search response ad and promotion filtering.
{
const scriptText = fs.readFileSync(new URL('../../../Rewrite/GeneralAdBlock/google-adblock.js', import.meta.url), 'utf8');
const script = new vm.Script(scriptText);
const moduleText = fs.readFileSync(new URL('../../../Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule', import.meta.url), 'utf8');
const searchUrl = 'https://www.google.com/search?q=example&udm=14';
const appUrl = 'https://iga.google.com/?url=googleapp%3A%2F%2Fhome&amp;utm_campaign=example';
const promo = `<div jscontroller="weWVtc" class="new-layout footer-card" data-url="${appUrl}" role="button"><span>Ask and explore anything with the Google app</span><div>Open</div></div>`;
const organic = '<div id="search"><h3>Ask and explore anything with the Google app</h3><a href="https://example.com/">Organic result</a></div>';
const footer = '<div id="footer"><span>Hong Kong</span><a href="/preferences">Settings</a></div>';
const hiddenStyle = ' style="display:none!important"';
const sponsored = '<div id="tads"><a href="/aclk?ad=example">Sponsored</a></div>';
const insertionEncodings = ['hex', 'unicode', 'literal', 'encoded-end'];
const htmlEncodings = ['plain', ...insertionEncodings];
const legacyClassOrders = ['B2VR9 CJHX3e', 'CJHX3e B2VR9'];
const nativeResponseCases = [];

function rewrite(body, options = {}) {
  let result;
  const headers = { 'Content-Type': 'text/html', 'Set-Cookie': ['first=one', 'second=two'] };
  const context = {
    $request: { url: options.url || searchUrl },
    $response: { body, headers, status: options.status ?? 200 },
    $done(value) {
      assert.equal(result, undefined, 'response must complete exactly once');
      result = value;
    }
  };
  script.runInNewContext(context, { timeout: 1000 });
  assert.notEqual(result, undefined);
  assert.deepEqual(headers['Set-Cookie'], ['first=one', 'second=two']);
  if (options.nativeFixture !== false) {
    nativeResponseCases.push({body, url: context.$request.url, status: context.$response.status,
      expected: JSON.parse(JSON.stringify(result))});
  }
  return { result, body: result.body ?? body, context };
}

function expectPassthrough(input, options) {
  const output = rewrite(input, options);
  assert.equal(output.body, input);
  assert.deepEqual(Object.keys(output.result), []);
}

function inserted(html, encoding) {
  let literal = JSON.stringify(html);
  if (encoding === 'hex' || encoding === 'encoded-end') literal = literal.replaceAll('<', '\\x3c');
  if (encoding === 'unicode') literal = literal.replaceAll('<', '\\u003c');
  if (encoding === 'encoded-end') literal = literal.replaceAll('>', '\\x3e');
  return `<script>jsl.dh("footer",${literal});</script>`;
}

function arcResponse(frames) {
  return ")]}'\n" + frames.map(frame => frame.length.toString(16) + ';' + frame).join('');
}

function browserPayload(html) {
  let payload;
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'expected the synthetic insertion script');
  vm.runInNewContext(match[1], { jsl: { dh(id, content) { payload = content; } } });
  assert.equal(typeof payload, 'string');
  return payload;
}

function arcFrames(text) {
  let remaining = text.replace(/^\)\]\}'\n/, '');
  const frames = [];
  while (remaining) {
    const match = /^([\da-f]+);/i.exec(remaining);
    assert.ok(match, 'invalid ARC length header');
    const length = parseInt(match[1], 16);
    frames.push(remaining.slice(match[0].length, match[0].length + length));
    assert.equal(frames.at(-1).length, length);
    remaining = remaining.slice(match[0].length + length);
  }
  return frames;
}

test('the installed Google rule matches search and pagination responses with a refreshed script version', () => {
  const line = moduleText.split('\n').find(line => line.startsWith('Google = '));
  const pattern = /pattern=(.*?), requires-body=true/.exec(line)[1];
  for (const url of [searchUrl, 'https://www.google.com/search?asearch=arc', 'https://www.google.com/search?async=arc_id%3Aexample']) {
    assert.ok(new RegExp(pattern).test(url));
  }
  assert.ok(line.endsWith('/google-adblock.js?v=1.0.22'));
  assert.ok(moduleText.includes('www.google.com'));
});

test('new footer layout hides only the Google app card and preserves results and footer links', () => {
  const input = `<html><body>${organic}${promo}${footer}</body></html>`;
  const output = rewrite(input).body;
  assert.notEqual(output, input);
  assert.equal(output.replace(hiddenStyle, ''), input);
  assert.ok(output.includes(organic));
  assert.ok(output.includes(footer));
  assert.match(output, /data-url="[^\"]+" role="button" style="display:none!important"/);
});

for (const encoding of insertionEncodings) {
  test(`JavaScript-inserted footer stays valid with ${encoding} HTML encoding`, () => {
    const input = `<html>${organic}${inserted(promo + footer, encoding)}</html>`;
    const output = rewrite(input).body;
    const before = browserPayload(input);
    const after = browserPayload(output);
    assert.equal(after.replace(hiddenStyle, ''), before);
    assert.match(after, /role="button" style="display:none!important"/);
    assert.ok(output.includes(organic));
  });
}

test('app destination detection is independent of layout classes, label language and attribute order', () => {
  const input = `<button DATA-URL = '${appUrl}' class='future-layout'>使用 Google 應用程式</button>`;
  assert.equal(rewrite(input).body.replace(" style='display:none!important'", ''), input);
  assert.notEqual(rewrite(input).body, input);
});

test('existing styles, quote escapes and dollar signs are preserved and repeated filtering is idempotent', () => {
  const styled = promo.replace('role="button"', 'role="button" style="color:red;--marker:$&"');
  for (const input of [styled, `<script>jsl.dh("footer",${JSON.stringify(styled).replaceAll('<', '\\x3c')});</script>`]) {
    const first = rewrite(input).body;
    assert.notEqual(first, input);
    assert.equal(first.replace('display:none!important;', ''), input);
    const second = rewrite(first);
    assert.equal(second.body, first);
    assert.deepEqual(Object.keys(second.result), []);
  }
});

test('HTML and JavaScript escaped query separators retain the original attribute bytes', () => {
  const destination = 'https://iga.google.com/?campaign=example&amp;url=googleapp%3A%2F%2Fhome';
  const input = promo.replace(appUrl, destination);
  assert.equal(rewrite(input).body.replace(hiddenStyle, ''), input);
  const encoded = `<script>jsl.dh("footer",${JSON.stringify(input).replaceAll('<', '\\x3c').replaceAll('&amp;', '\\x26')});</script>`;
  const output = rewrite(encoded).body;
  assert.equal(browserPayload(output).replace(hiddenStyle, ''), browserPayload(encoded));
});

test('ordinary app mentions, unrelated targets, malformed URLs and similar domains remain byte-identical', () => {
  const inputs = [
    organic + footer,
    '<div data-note="Ask and explore anything with the Google app">Ordinary content</div>',
    promo.replace(appUrl, 'https://iga.google.com.evil.test/?url=googleapp%3A%2F%2Fhome'),
    promo.replace(appUrl, 'https://example.com/?url=googleapp%3A%2F%2Fhome'),
    promo.replace(appUrl, 'https://iga.google.com/?url=https%3A%2F%2Fexample.com'),
    promo.replace(appUrl, 'https://iga.google.com/?url=%E0%A4%A'),
    '<div data-example="unrelated" class="new-layout">Open</div>'
  ];
  for (const input of inputs) {
    const output = rewrite(input);
    assert.equal(output.body, input);
    assert.deepEqual(Object.keys(output.result), []);
  }
});

test('Sponsored Results and verified app cards stay hidden beside ordinary results', () => {
  const input = sponsored + promo + organic;
  const expected = sponsored.replace('id="tads">', 'id="tads"' + hiddenStyle + '>') +
    promo.replace('role="button">', 'role="button"' + hiddenStyle + '>') + organic;
  const output = rewrite(input);
  assert.equal(output.body, expected);
  assert.deepEqual(Object.keys(output.result), ['body']);
  expectPassthrough(output.body);
});

test('redirects, challenges and non-Google pages pass through without replacing headers or body', () => {
  for (const status of [302, 403, 429, 503]) {
    assert.deepEqual(Object.keys(rewrite(promo, { status }).result), []);
  }
  assert.deepEqual(Object.keys(rewrite(promo, { url: 'https://example.com/search?q=example' }).result), []);
});

test('ARC pagination preserves same-class results and updates lengths for verified promotions', () => {
  const result = '<div class="B2VR9 CJHX3e">正常搜尋結果 😀</div>';
  const legacyPromo = promo.replace('new-layout footer-card', 'B2VR9 CJHX3e');
  const hiddenPromo = legacyPromo.replace('role="button">', 'role="button"' + hiddenStyle + '>');
  const ordinary = result + organic;
  const input = arcResponse([ordinary, inserted(result + legacyPromo, 'hex'), sponsored, footer]);
  const expectedFrames = [
    ordinary,
    inserted(result + hiddenPromo, 'hex'),
    sponsored.replace('id="tads">', 'id="tads"' + hiddenStyle + '>'),
    footer
  ];
  for (const query of ['asearch=arc', 'async=arc_id%3Aexample']) {
    const options = { url: 'https://www.google.com/search?' + query };
    const output = rewrite(input, options).body;
    assert.equal(output, arcResponse(expectedFrames));
    assert.equal(browserPayload(arcFrames(output)[1]), result + hiddenPromo);
    expectPassthrough(output, options);
    expectPassthrough(arcResponse([ordinary, footer]), options);
    expectPassthrough(input.slice(0, -2), options);
  }
});

test('private Google HAR replay removes the captured footer promotion without changing any other bytes', {
  skip: !process.env.GOOGLE_ADBLOCK_HAR_PATH
}, () => {
  const entries = JSON.parse(fs.readFileSync(process.env.GOOGLE_ADBLOCK_HAR_PATH, 'utf8')).log.entries;
  let replayed = 0;
  for (const entry of entries) {
    const url = new URL(entry.request.url);
    if (url.hostname !== 'www.google.com' || url.pathname !== '/search') continue;
    const content = entry.response?.content || {};
    const input = content.encoding === 'base64' ? Buffer.from(content.text || '', 'base64').toString('utf8') : content.text || '';
    const output = rewrite(input, { url: entry.request.url, status: entry.response.status, nativeFixture: false });
    if (!input.includes('Ask and explore anything with the Google app')) {
      assert.ok(output.body === input, 'unrelated captured response must pass through');
      continue;
    }
    replayed++;
    assert.ok(output.body !== input, 'captured Google app promotion must be hidden');
    assert.ok(output.body.replace(' style=\\"display:none!important\\"', '') === input,
      'only the captured card opening tag may change');
    const inputScripts = [...input.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    const outputScripts = [...output.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.equal(outputScripts.length, inputScripts.length);
    let changedScripts = 0;
    for (let i = 0; i < inputScripts.length; i++) {
      if (inputScripts[i][1] === outputScripts[i][1]) continue;
      changedScripts++;
      new vm.Script(inputScripts[i][1]);
      new vm.Script(outputScripts[i][1]);
    }
    assert.equal(changedScripts, 1, 'only the footer insertion script may change');
  }
  assert.ok(replayed > 0, 'HAR must contain the captured footer promotion');
});

for (const classes of legacyClassOrders) {
  for (const encoding of htmlEncodings) {
    test(`separate promotion text leaves legacy class ${classes} results intact in ${encoding} HTML`, () => {
      const result = `<div class="${classes}"><a href="https://example.com/">正常搜尋結果</a></div>`;
      const html = result + organic + result;
      expectPassthrough(encoding === 'plain' ? html : inserted(html, encoding));
    });
  }
}

test('only the verified app card changes beside same-class siblings and ancestors', () => {
  for (const classes of legacyClassOrders) {
    const result = `<div class="${classes}">正常搜尋結果</div>`;
    const parent = `<main class="${classes}">`;
    const card = promo.replace('new-layout footer-card', classes);
    const hiddenCard = card.replace('role="button">', 'role="button"' + hiddenStyle + '>');
    const html = parent + result + card + result + '</main>';
    const expected = parent + result + hiddenCard + result + '</main>';
    for (const encoding of htmlEncodings) {
      const input = encoding === 'plain' ? html : inserted(html, encoding);
      const output = rewrite(input);
      assert.equal(output.body, encoding === 'plain' ? expected : inserted(expected, encoding));
      assert.deepEqual(Object.keys(output.result), ['body']);
      expectPassthrough(output.body);
    }
  }
});

test('legacy text and classes keep cards visible without a verified app destination', () => {
  for (const classes of legacyClassOrders) {
    const card = promo.replace('new-layout footer-card', classes);
    for (const destination of [
      '',
      'https://example.com/',
      'https://iga.google.com.evil.test/?url=googleapp%3A%2F%2Fhome',
      'https://iga.google.com/?url=googleapp%3A%2F%2Fhomepage',
      'https://iga.google.com/?url=%E0%A4%A'
    ]) {
      const html = destination ? card.replace(appUrl, destination) : card.replace(` data-url="${appUrl}"`, '');
      expectPassthrough(html);
      expectPassthrough(inserted(html, 'hex'));
    }
  }
});

test('quoted class examples in JavaScript stay intact beside an ordinary app mention', () => {
  const example = '<div class="B2VR9 CJHX3e">Documentation example</div>';
  expectPassthrough(organic + `<script>const example = ${JSON.stringify(example)};</script>`);
});

test('native JavaScriptCore matches response filtering fixtures and completes exactly once', {
  skip: process.platform !== 'darwin'
}, () => {
  assert.ok(nativeResponseCases.length >= 50, 'response fixtures must be exercised before native replay');
  const code = 'const source=' + JSON.stringify(scriptText) + ', cases=' + JSON.stringify(nativeResponseCases) + ';'
    + 'const run=new Function("$request","$response","$done",source); let failures=[];'
    + 'cases.forEach((c,i)=>{let results=[]; const headers={"Content-Type":"text/html","Set-Cookie":["first=one","second=two"]};'
    + 'try{run({url:c.url},{body:c.body,headers:headers,status:c.status},v=>results.push(v));'
    + 'if(results.length!==1||JSON.stringify(results[0])!==JSON.stringify(c.expected)||'
    + 'JSON.stringify(headers["Set-Cookie"])!==JSON.stringify(["first=one","second=two"])) failures.push(i);'
    + '}catch(e){failures.push(i);}}); JSON.stringify({count:cases.length,failures:failures});';
  const result = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript'], {
    input: code, encoding: 'utf8', timeout: 15000
  }));
  assert.equal(result.count, nativeResponseCases.length);
  assert.deepEqual(result.failures, []);
});
}
