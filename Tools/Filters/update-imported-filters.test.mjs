import assert from "node:assert/strict";
import test from "node:test";

import {
  applyUpstreamDelta,
  buildSnapshot,
  calculateChange,
  mergeImportedRules,
  parseRuleLine,
  parseRuleText,
  parseTargetFile,
  renderTargetFile,
} from "./update-imported-filters.mjs";

test("normalizes supported rules and removes policy fields", () => {
  const rules = parseRuleText(`
# comment
DOMAIN-SUFFIX,Example.COM,reject
IP-CIDR6,2001:db8::/32,no-resolve
DOMAIN-SUFFIX,example.com,reject
`);

  assert.deepEqual(
    rules.map((rule) => rule.line),
    ["DOMAIN-SUFFIX, example.com", "IP-CIDR6, 2001:db8::/32"],
  );
});

test("rejects unknown rule types and invalid CIDR values", () => {
  assert.throws(() => parseRuleLine("URL-REGEX,^https://example.com"), /unsupported rule type/u);
  assert.throws(() => parseRuleLine("IP-CIDR,2001:db8::\/32"), /invalid IP-CIDR/u);
});

test("preserves the manual section and reads source comments", () => {
  const target = parseTargetFile(`
#AI Generated
DOMAIN, manual.example
URL-REGEX,^https:\/\/example.com\/track

# Imported List
# Source: https://raw.githubusercontent.com/example/repo/main/one.list
DOMAIN, imported.example
`);

  assert.equal(target.manualText.includes("URL-REGEX"), true);
  assert.deepEqual(target.sourceUrls, [
    "https://raw.githubusercontent.com/example/repo/main/one.list",
  ]);
  assert.equal(target.manualRuleKeys.has("DOMAIN\u0000manual.example"), true);
});

test("deduplicates imported rules against manual rules and sorts by type", () => {
  const groups = [
    parseRuleText("DOMAIN-SUFFIX,z.example,reject\nDOMAIN,manual.example,reject"),
    parseRuleText("DOMAIN,a.example\nDOMAIN-SUFFIX,z.example"),
  ];
  const merged = mergeImportedRules(groups, new Set(["DOMAIN\u0000manual.example"]));

  assert.deepEqual(
    merged.map((rule) => rule.line),
    ["DOMAIN, a.example", "DOMAIN-SUFFIX, z.example"],
  );
});

test("renders a deterministic imported section and measures churn", () => {
  const oldRules = parseRuleText("DOMAIN,old.example\nDOMAIN,keep.example");
  const newRules = parseRuleText("DOMAIN,keep.example\nDOMAIN,new.example");
  const output = renderTargetFile({
    importedRules: newRules,
    manualText: "#AI Generated\nDOMAIN, manual.example",
    sourceUrls: ["https://raw.githubusercontent.com/example/repo/main/list"],
  });

  assert.equal(output.endsWith("DOMAIN, new.example\n"), true);
  assert.deepEqual(calculateChange(oldRules, newRules), {
    added: 1,
    ratio: 1,
    removed: 1,
  });
});

test("tracks only upstream deltas and preserves deliberate omissions", () => {
  const previous = parseRuleText(
    "DOMAIN,keep.example\nDOMAIN,omitted.example\nDOMAIN,removed.example",
  );
  const current = parseRuleText("DOMAIN,keep.example\nDOMAIN,removed.example");
  const next = parseRuleText(
    "DOMAIN,keep.example\nDOMAIN,omitted.example\nDOMAIN,new.example",
  );

  assert.deepEqual(
    applyUpstreamDelta(current, previous, next).map((rule) => rule.line),
    ["DOMAIN, keep.example", "DOMAIN, new.example"],
  );
});

test("builds deterministic source state", () => {
  const snapshot = buildSnapshot([
    {
      rules: parseRuleText("DOMAIN-SUFFIX,z.example\nDOMAIN,a.example"),
      url: "https://raw.githubusercontent.com/example/repo/main/one.list",
    },
    {
      rules: parseRuleText("DOMAIN,a.example\nDOMAIN,b.example"),
      url: "https://raw.githubusercontent.com/example/repo/main/two.list",
    },
  ]);

  assert.deepEqual(snapshot.rules, [
    "DOMAIN, a.example",
    "DOMAIN, b.example",
    "DOMAIN-SUFFIX, z.example",
  ]);
  assert.deepEqual(
    snapshot.sources.map(({ ruleCount, url }) => ({ ruleCount, url })),
    [
      {
        ruleCount: 2,
        url: "https://raw.githubusercontent.com/example/repo/main/one.list",
      },
      {
        ruleCount: 2,
        url: "https://raw.githubusercontent.com/example/repo/main/two.list",
      },
    ],
  );
});
