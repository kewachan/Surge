const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const walk = directory => fs.readdirSync(path.join(root, directory), {withFileTypes: true})
  .flatMap(item => item.isDirectory() ? walk(path.join(directory, item.name)) : [path.join(directory, item.name)]);
const modules = [...walk('Rewrite'), ...walk('Tools')].filter(file => file.endsWith('.sgmodule'));
const records = [];

function render(text) {
  const declaration = /^#!arguments\s*=\s*(.*)$/m.exec(text)?.[1] || '';
  const defaults = new Map((declaration.match(/(?:[^,"]|"[^"]*")+/g) || []).map(part => {
    const at = part.indexOf(':');
    const name = (at < 0 ? part : part.slice(0, at)).trim();
    const raw = at < 0 ? '' : part.slice(at + 1).trim();
    let value = raw;
    try { value = JSON.parse(raw); } catch (_) {}
    return [name, value];
  }));
  return text.replace(/\{\{\{([^}]+)\}\}\}/g, (_all, name) => {
    assert(defaults.has(name), 'Missing module argument: ' + name);
    return String(defaults.get(name));
  });
}

test('all module arguments resolve; local scripts exist and script names are unique', () => {
  assert.equal(modules.length, 8);
  const names = new Set();
  for (const file of modules) {
    let section = '';
    for (const [index, raw] of render(fs.readFileSync(path.join(root, file), 'utf8')).split('\n').entries()) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[')) { section = line; continue; }
      let pattern;
      if (section === '[Script]') {
        const name = line.split('=')[0].trim();
        assert(!names.has(name), 'Duplicate script: ' + name); names.add(name);
        const own = /script-path=https:\/\/raw\.githubusercontent\.com\/kewachan\/Surge\/main\/([^,?]+)/.exec(line);
        if (own) assert(fs.existsSync(path.join(root, own[1])), file + ': missing ' + own[1]);
        pattern = /\bpattern=(.*?)(?=,\s*[\w-]+=|$)/.exec(line)?.[1];
      } else if (section === '[URL Rewrite]' || section === '[Map Local]') {
        const match = /^("(?:\\.|[^"\\])*"|\S+)\s+(.*)$/.exec(line);
        assert(match, file + ': malformed rule');
        pattern = match[1].replace(/^"|"$/g, '');
        if (section === '[URL Rewrite]') assert(/\s+(?:header|reject|302|307)$/.test(match[2]), file + ': missing target/type');
        else if (line.includes('header=')) assert(/header="[^"\n]*:/.test(line), file + ': invalid mock header');
      } else if (section === '[Body Rewrite]') pattern = line.split(/\s+/)[1];
      if (pattern) records.push({file, line: index + 1, section, pattern});
    }
  }
});

test('conditional Bilibili endpoints no longer have unconditional static overrides', () => {
  const text = fs.readFileSync(path.join(root, 'Rewrite/Bilibili/Bilibili.Enhance.sgmodule'), 'utf8');
  const beforeScripts = text.split('[Script]')[0];
  for (const fragment of ['mix_uplist', 'topic_svr', 'recommend_words', 'DefaultWords']) assert(!beforeScripts.includes(fragment));
  assert(beforeScripts.includes('if ("{{{PGC.AD}}}" | ascii_downcase) == "true" then del(.data.payment) else . end'));
  assert.equal((beforeScripts.match(/data-type=text/g) || []).length, 2);
  assert(!text.includes('data="{"code"'));
});

test('Adrewrite supplies exact MITM hosts and valid HTTP/HTTPS matching', () => {
  const text = fs.readFileSync(path.join(root, 'Rewrite/Adrewrite.sgmodule'), 'utf8');
  const hosts = text.split('hostname = %APPEND% ')[1].trim().split(',').map(item => item.trim());
  for (const host of ['plus.maasplus.com', 'macaumovie.com', '3p.ampproject.net', 'd-*.ampproject.net', 'statistic.live.126.net']) assert(hosts.includes(host));
  assert(!text.includes('^http?:'));
});

test('native ICU compiles every HTTP pattern and preserves required Bahamut player resources', {skip: process.platform !== 'darwin'}, () => {
  assert(records.length > 1300);
  const source = 'ObjC.import("Foundation"); const records=' + JSON.stringify(records) + ';'
    + 'const failures=[], hits=[];const urls=["animeVideo","animeVideo2","animeLogo"].flatMap(n=>["",":443"].map(port=>"https://i2.bahamut.com.tw"+port+"/JS/ad/"+n+".js?v=123"));'
    + 'for(const item of records){const error=Ref(); const re=$.NSRegularExpression.regularExpressionWithPatternOptionsError($(item.pattern),0,error);'
    + 'if(ObjC.unwrap(re)===undefined){failures.push(item);continue;}'
    + 'if(item.file==="Rewrite/Advertising.sgmodule")for(const url of urls){if(ObjC.unwrap(re.firstMatchInStringOptionsRange($(url),0,$.NSMakeRange(0,url.length)))!==undefined)hits.push({line:item.line,url:url});}}'
    + 'JSON.stringify({count:records.length,failures:failures,hits:hits});';
  const result = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript'], {input: source, encoding: 'utf8', timeout: 15000}));
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.hits, []);
});
