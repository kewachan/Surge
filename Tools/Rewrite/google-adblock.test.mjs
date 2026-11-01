import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scriptText = fs.readFileSync(new URL('../../Rewrite/GeneralAdBlock/google-adblock.js', import.meta.url), 'utf8');
const script = new vm.Script(scriptText);
const moduleText = fs.readFileSync(new URL('../../Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule', import.meta.url), 'utf8');
const searchUrl = 'https://www.google.com/search?q=example&udm=14';
const appUrl = 'https://iga.google.com/?url=googleapp%3A%2F%2Fhome&amp;utm_campaign=example';
const promo = `<div jscontroller="weWVtc" class="new-layout footer-card" data-url="${appUrl}" role="button"><span>Ask and explore anything with the Google app</span><div>Open</div></div>`;
const organic = '<div id="search"><h3>Ask and explore anything with the Google app</h3><a href="https://example.com/">Organic result</a></div>';
const footer = '<div id="footer"><span>Hong Kong</span><a href="/preferences">Settings</a></div>';
const hiddenStyle = ' style="display:none!important"';

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
  return { result, body: result.body ?? body, context };
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
  assert.ok(line.endsWith('/google-adblock.js?v=1.0.20'));
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

for (const encoding of ['hex', 'unicode', 'literal', 'encoded-end']) {
  test(`JavaScript-inserted footer stays valid with ${encoding} HTML encoding`, () => {
    let literal = JSON.stringify(promo + footer);
    if (encoding === 'hex' || encoding === 'encoded-end') literal = literal.replaceAll('<', '\\x3c');
    if (encoding === 'unicode') literal = literal.replaceAll('<', '\\u003c');
    if (encoding === 'encoded-end') literal = literal.replaceAll('>', '\\x3e');
    const input = `<html>${organic}<script>jsl.dh("footer",${literal});</script></html>`;
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

test('legacy app cards and sponsored results keep their original filtering', () => {
  const legacy = '<div class="B2VR9 CJHX3e">Ask and explore anything with the Google app</div>';
  const sponsored = '<div id="tads"><a href="/aclk?ad=example">Sponsored</a></div>';
  const output = rewrite(legacy + sponsored + organic).body;
  assert.match(output, /class="B2VR9 CJHX3e" style="display:none!important"/);
  assert.match(output, /id="tads" style="display:none!important"/);
  assert.ok(output.endsWith(organic));
});

test('redirects, challenges and non-Google pages pass through without replacing headers or body', () => {
  for (const status of [302, 403, 429, 503]) {
    assert.deepEqual(Object.keys(rewrite(promo, { status }).result), []);
  }
  assert.deepEqual(Object.keys(rewrite(promo, { url: 'https://example.com/search?q=example' }).result), []);
});

test('ARC pagination updates lengths while retaining unrelated frames and valid inserted JavaScript', () => {
  const insertion = `<script>jsl.dh("footer",${JSON.stringify(promo).replaceAll('<', '\\x3c')});</script>`;
  const input = ")]}'\n" + [organic, insertion, footer].map(frame => frame.length.toString(16) + ';' + frame).join('');
  for (const query of ['asearch=arc', 'async=arc_id%3Aexample']) {
    const output = rewrite(input, { url: 'https://www.google.com/search?' + query }).body;
    const frames = arcFrames(output);
    assert.equal(frames[0], organic);
    assert.equal(frames[2], footer);
    assert.match(browserPayload(frames[1]), /style="display:none!important"/);
  }
  const truncated = input.slice(0, -2);
  assert.deepEqual(Object.keys(rewrite(truncated, { url: 'https://www.google.com/search?asearch=arc' }).result), []);
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
    const output = rewrite(input, { url: entry.request.url, status: entry.response.status });
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
