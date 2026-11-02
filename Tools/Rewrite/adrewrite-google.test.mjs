import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
const moduleText = fs.readFileSync(new URL('../../Rewrite/Adrewrite.sgmodule', import.meta.url), 'utf8');
const declaration = moduleText.split('\n').find(line => line.startsWith('google.search.request ='));
const pattern = new RegExp(/pattern=(.*?),engine=/.exec(declaration)[1]);
const scriptSource = fs.readFileSync(new URL('../../Rewrite/google-search.request.js', import.meta.url), 'utf8');
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
