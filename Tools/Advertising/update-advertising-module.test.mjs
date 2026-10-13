import assert from "node:assert/strict";
import test from "node:test";

import {
  applyUpstreamDelta,
  buildSnapshot,
  calculateChange,
  parseMitmHosts,
  parseSourceDefinitions,
  parseTargetModule,
  parseUrlRewriteSection,
  renderTargetModule,
  setModuleUpdatedDate,
} from "./update-advertising-module.mjs";

const SOURCE = "https://raw.githubusercontent.com/example/repo/main/module.sgmodule";

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
