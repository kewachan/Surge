import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const moduleText = fs.readFileSync(new URL('../../Rewrite/Adrewrite.sgmodule', import.meta.url), 'utf8');
const googleSection = moduleText.split('#Google\n')[1].split('\n\n')[0];
const redirects = googleSection.split('\n').filter(line => line.endsWith(' 302')).map(line => {
  const [pattern, replacement, type] = line.split(/\s+/);
  assert.equal(type, '302');
  return {pattern: new RegExp(pattern), replacement};
});

function rewrite(url) {
  for (const rule of redirects) {
    if (rule.pattern.test(url)) return url.replace(rule.pattern, rule.replacement);
  }
  return url;
}

test('Safari search retains existing region preferences and parameters after client', () => {
  const input = 'https://www.google.com/search?q=hello%20world&client=safari&ie=UTF-8&oe=UTF-8&ei=opaque%2Bvalue';
  const output = rewrite(input);
  assert.equal(output, 'https://www.google.com/search?q=hello%20world&ie=UTF-8&oe=UTF-8&ei=opaque%2Bvalue&gl=hk&safe=off&udm=14');
  assert.equal(rewrite(output), output, 'must not create a redirect loop');
});

test('ordinary searches use Web even without a Safari client parameter or with reordered parameters', () => {
  for (const query of ['q=hello', 'client=safari&q=hello&hl=zh-HK', 'hl=zh-HK&q=hello',
    'q=%E6%BE%B3%E9%96%80%26udm%3D2', 'q=hello&x=tbm%3Disch', 'q=hello&start=10',
    'q=hello&gl=tw&safe=active']) {
    const input = 'https://www.google.com/search?' + query;
    const output = rewrite(input);
    assert.equal(output, 'https://www.google.com/search?udm=14&' + query);
    assert.equal(rewrite(output), output);
  }
});

test('explicit Web, AI, image, video, news and other search modes stay untouched', () => {
  for (const mode of ['udm=14', 'udm=50', 'udm=2', 'udm=7', 'udm=28', 'tbm=isch', 'tbm=vid',
    'tbm=nws', 'tbm=shop', 'tbm=bks', 'udm=', 'tbm=']) {
    for (const query of [`q=hello&client=safari&${mode}`, `${mode}&q=hello&client=safari`,
      `q=hello&${mode}&client=safari`]) {
      const input = 'https://www.google.com/search?' + query;
      assert.equal(rewrite(input), input);
    }
  }
});

test('fragments and encoded values survive, and only the exact existing Google search host matches', () => {
  const safari = 'https://www.google.com/search?q=hello%26client%3Dtest&client=safari&hl=en#section';
  const fallback = 'https://www.google.com/search?q=hello%26client%3Dtest#section';
  assert.equal(rewrite(safari), 'https://www.google.com/search?q=hello%26client%3Dtest&hl=en&gl=hk&safe=off&udm=14#section');
  assert.equal(rewrite(fallback), 'https://www.google.com/search?udm=14&q=hello%26client%3Dtest#section');
  for (const input of ['https://www.google.com/search?client=safari', 'https://www.google.com/search?q=',
    'https://www.google.com/search?other=q=hello', 'https://www.google.com/searching?q=hello',
    'https://www.google.com/ads/on-device/conversions?q=hello', 'https://www.google.com.evil.test/search?q=hello',
    'https://accounts.google.com/search?q=hello', 'https://example.com/path/https://www.google.com/search?q=hello']) {
    assert.equal(rewrite(input), input);
  }
});

test('existing Google ad blocks and MITM coverage remain in place', () => {
  const blocks = googleSection.split('\n').filter(line => line.endsWith(' - reject'));
  assert.equal(blocks.length, 3);
  assert(moduleText.includes('google.com, *.google.com,'));
});
