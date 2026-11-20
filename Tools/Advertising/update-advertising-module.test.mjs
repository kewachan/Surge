import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyUpstreamDelta,
  assertNoDeniedMitmHosts,
  buildSnapshot,
  calculateChange,
  parseMitmHosts,
  parseSourceDefinitions,
  parseTargetModule,
  parseUrlRewriteSection,
  protectPlayerResources,
  requireReviewedMitmAdditions,
  renderTargetModule,
  run,
  setModuleUpdatedDate,
} from "./update-advertising-module.mjs";

const SOURCE = "https://raw.githubusercontent.com/example/repo/main/module.sgmodule";

test("the actual Advertising module contains no denied MITM hosts", () => {
  const text = readFileSync(new URL("../../Rewrite/Advertising.sgmodule", import.meta.url), "utf8");
  assert.doesNotThrow(() => assertNoDeniedMitmHosts(parseTargetModule(text).mitmHosts));
});

test("denied hosts already in a module fail validation regardless of upstream state", () => {
  for (const host of ["m.airchina.com.cn", "GQL.REDDIT.COM", "*.fuliapps.com", "yuudnn.lz-qs.com:9220"]) {
    const current = ["valid.example", host];
    const state = [host];
    const proposed = applyUpstreamDelta(current, state, state, new Set([host]));
    assert.throws(() => assertNoDeniedMitmHosts(proposed), /contains denied MITM hosts/);
    assert.deepEqual(current, ["valid.example", host]);
  }
  assert.doesNotThrow(() => assertNoDeniedMitmHosts(["other.example", "api.reddit.com"]));
});

test("generic ad-path filtering preserves only the three Bahamut player scripts across upstream deltas", () => {
  const broad = '"(?i)\\b\\/ad\\/" - reject';
  const [protectedRule] = protectPlayerResources([broad]);
  const pattern = protectedRule.match(/^"(.*)" - reject$/u)[1];
  const regex = new RegExp(pattern.replace(/^\(\?i\)/u, ""), "i");
  for (const name of ["animeVideo", "animeVideo2", "animeLogo"]) {
    for (const port of ["", ":443"]) for (const suffix of ["", "?v=123", "#part"]) assert(!regex.test(`https://i2.bahamut.com.tw${port}/JS/ad/${name}.js${suffix}`));
  }
  for (const url of ["https://example.test/ad/animeVideo.js", "https://i2.bahamut.com.tw/JS/ad/banner.js",
    "https://i2.bahamut.com.tw/JS/ad/animeVideo.js.evil", "https://i2.bahamut.com.tw.evil/JS/ad/animeVideo.js",
    "https://i2.bahamut.com.tw:8443/JS/ad/animeVideo.js", "https://i2.bahamut.com.tw:443/JS/ad/banner.js"]) assert(regex.test(url));
  const legacy = protectedRule.replace('(?::443)?', '');
  assert.deepEqual(protectPlayerResources([legacy, broad]), [protectedRule]);
  assert.deepEqual(protectPlayerResources([protectedRule, broad]), [protectedRule]);
  assert.deepEqual(applyUpstreamDelta([protectedRule], protectPlayerResources([broad]), [], new Set()), []);
  assert.deepEqual(applyUpstreamDelta([], [], protectPlayerResources([broad]), new Set()), [protectedRule]);
});

test("parses source roles from the module header", () => {
  const definitions = parseSourceDefinitions(`
# Source: ${SOURCE}
# MITM audit: https://ruleset.skk.moe/Modules/audit.sgmodule
`);

  assert.deepEqual(definitions, [
    { role: "source", url: SOURCE },
    { role: "mitm-audit", url: "https://ruleset.skk.moe/Modules/audit.sgmodule" },
  ]);
});

test("parses only active URL Rewrite rules and MITM hosts", () => {
  const module = `
#!name=Fixture

[URL Rewrite]
# comment
^https://ads\\.example/ - reject
^https://old\\.example/ https://new.example/ 302

[MITM]
hostname-disabled = %APPEND% disabled.example
hostname = %APPEND% ads.example, *.tracker.example
`;

  assert.deepEqual(parseUrlRewriteSection(module), [
    "^https://ads\\.example/ - reject",
    "^https://old\\.example/ https://new.example/ 302",
  ]);
  assert.deepEqual(parseMitmHosts(module), ["ads.example", "*.tracker.example"]);
});

test("rejects HTML and unsupported module syntax", () => {
  assert.throws(() => parseUrlRewriteSection("<html>moved</html>"), /URL Rewrite/u);
  assert.throws(
    () => parseUrlRewriteSection("[URL Rewrite]\n^https://ads\\.example/ script-path"),
    /unsupported URL Rewrite action/u,
  );
  assert.throws(
    () => parseMitmHosts("[MITM]\nca-passphrase = secret"),
    /unsupported \[MITM\] entry/u,
  );
});

test("applies only upstream deltas and preserves curated omissions", () => {
  const proposed = applyUpstreamDelta(
    ["manual", "keep", "obsolete"],
    ["keep", "omitted", "obsolete"],
    ["keep", "omitted", "new", "blocked"],
    new Set(["blocked"]),
  );

  assert.deepEqual(proposed, ["manual", "keep", "new"]);
});

test("new MITM hosts stop updates until explicitly reviewed, without changing existing hosts", () => {
  const current = ["keep.example", "manual.example"];
  const next = ["keep.example", "manual.example", "*.new.example", "api.example:8443"];
  const hash = createHash("sha256").update("*.new.example\napi.example:8443\n").digest("hex");
  assert.throws(() => requireReviewedMitmAdditions(current, next), (error) => error.message.includes(hash));
  assert.deepEqual(current, ["keep.example", "manual.example"]);
  assert.deepEqual(requireReviewedMitmAdditions(current, next, hash), ["*.new.example", "api.example:8443"]);
  assert.deepEqual(requireReviewedMitmAdditions(current, [...next].reverse(), hash), ["*.new.example", "api.example:8443"]);
  assert.throws(() => requireReviewedMitmAdditions(current, [...next, "later.example"], hash), /require review/u);
  assert.throws(() => requireReviewedMitmAdditions(current, next.slice(0, -1), hash), /require review/u);
  assert.throws(() => requireReviewedMitmAdditions(current, next, "bad"), /lowercase SHA-256/u);
  assert.throws(() => requireReviewedMitmAdditions(current, current, hash), /require review/u);
  assert.throws(() => assertNoDeniedMitmHosts([...current, "m.airchina.com.cn"]), /denied MITM/u);
  assert.deepEqual(requireReviewedMitmAdditions(current, ["keep.example"]), []);
});

test("MITM fingerprint gates the complete update and rejects changed upstream hosts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-mitm-test-"));
  const target = path.join(dir, "target.sgmodule"), state = path.join(dir, "state.json");
  const rule = "^https://old.example/ - reject";
  const initial = renderTargetModule({preamble: `#!name=Fixture\n#!date=2026-01-01\n# Source: ${SOURCE}`, mitmHosts: ["old.example"], urlRewrite: [rule]});
  const snapshot = buildSnapshot([{role: "source", url: SOURCE, mitmHosts: ["old.example"], urlRewrite: [rule]}]);
  const previousFetch = globalThis.fetch;
  let hosts = ["old.example", "new.example"];
  const mockFetch = async () => new Response(renderTargetModule({preamble: "#!name=Source", mitmHosts: hosts, urlRewrite: [rule, "^https://new.example/ - reject"]}), {status: 200});
  globalThis.fetch = async (...args) => { const response = await mockFetch(...args); Object.defineProperty(response, "url", {value: SOURCE}); return response; };
  const args = ["--file", target, "--state-file", state, "--allow-large-change"];
  try {
    await writeFile(target, initial);
    const initialState = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFile(state, initialState);
    let message;
    await assert.rejects(run(args), (error) => { message = error.message; return /require review/u.test(message); });
    const fingerprint = /SHA-256: ([a-f0-9]{64})/u.exec(message)[1];
    assert.equal(await readFile(target, "utf8"), initial);
    assert.equal(await readFile(state, "utf8"), initialState);
    hosts = [...hosts, "later.example"];
    await assert.rejects(run([...args, "--approved-mitm-sha256", fingerprint]), /require review/u);
    assert.equal(await readFile(target, "utf8"), initial);
    assert.equal(await readFile(state, "utf8"), initialState);
    hosts = ["old.example", "new.example"];
    await run([...args, "--approved-mitm-sha256", fingerprint]);
    assert.deepEqual(parseTargetModule(await readFile(target, "utf8")).mitmHosts, ["old.example", "new.example"]);
    assert.equal(parseTargetModule(await readFile(target, "utf8")).urlRewrite.length, 2);
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")).mitmHosts, ["new.example", "old.example"]);
    await assert.rejects(run([...args, "--allow-mitm-additions"]), /Unknown argument/u);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, {recursive: true, force: true});
  }
});

test("builds deterministic state and ignores audit rewrite rules", () => {
  const snapshot = buildSnapshot([
    {
      mitmHosts: ["b.example", "a.example"],
      role: "source",
      url: SOURCE,
      urlRewrite: ["z - reject", "a - reject"],
    },
    {
      mitmHosts: ["audit.example"],
      role: "mitm-audit",
      url: "https://ruleset.skk.moe/Modules/audit.sgmodule",
      urlRewrite: ["ignored - reject"],
    },
  ]);

  assert.deepEqual(snapshot.urlRewrite, ["a - reject", "z - reject"]);
  assert.deepEqual(snapshot.mitmHosts, ["a.example", "audit.example", "b.example"]);
  assert.equal(snapshot.sources[1].urlRewriteCount, 0);
});

test("renders a valid target and measures additions and removals", () => {
  const text = renderTargetModule({
    mitmHosts: ["ads.example"],
    preamble: `#!name=Fixture\n# Source: ${SOURCE}`,
    urlRewrite: ["^https://ads\\.example/ - reject"],
  });
  const target = parseTargetModule(text);

  assert.deepEqual(target.urlRewrite, ["^https://ads\\.example/ - reject"]);
  assert.deepEqual(target.mitmHosts, ["ads.example"]);
  assert.deepEqual(calculateChange(["old", "keep"], ["keep", "new"]), {
    added: 1,
    ratio: 1,
    removed: 1,
  });
});

test("inserts and replaces the module update date", () => {
  const module = "#!name=Fixture\n#!category=Advertising\n\n[URL Rewrite]\n";
  const dated = setModuleUpdatedDate(module, "2026-10-13");

  assert.equal(dated.includes("#!category=Advertising\n#!date=2026-10-13\n"), true);
  assert.equal(
    setModuleUpdatedDate(dated, "2026-10-14").includes("#!date=2026-10-14"),
    true,
  );
  assert.equal(setModuleUpdatedDate(dated, "2026-10-14").match(/^#!date=/gmu)?.length, 1);
});
