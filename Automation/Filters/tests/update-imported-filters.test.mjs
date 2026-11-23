import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeUpdatePair } from "../../write-update-pair.mjs";

import {
  applyUpstreamDelta,
  buildSnapshot,
  calculateChange,
  mergeImportedRules,
  parseRuleLine,
  parseRuleText,
  parseTargetFile,
  renderTargetFile,
  run,
  setFilterUpdatedDate,
} from "../update-imported-filters.mjs";

test("failed state replacement restores both filter and source state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-filter-pair-"));
  const target = path.join(dir, "filter.list"), state = path.join(dir, "state.json");
  const url = "https://raw.githubusercontent.com/example/repo/main/list";
  const original = `# Last Updated: 2026-01-01\n\n# Imported List\n# Source: ${url}\nDOMAIN, old.example\n`;
  const snapshot = `${JSON.stringify(buildSnapshot([{url, rules: parseRuleText("DOMAIN,old.example")}]), null, 2)}\n`;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const response = new Response("DOMAIN,old.example\nDOMAIN,new.example\n");
    Object.defineProperty(response, "url", {value: url});
    return response;
  };
  try {
    await writeFile(target, original);
    await writeFile(state, snapshot);
    const io = {writeFile, unlink, rename: async (from, to) => {
      if (to === state) throw new Error("state rename failed");
      return rename(from, to);
    }};
    const args = ["--file", target, "--state-file", state, "--allow-large-change"];
    await assert.rejects(run(args, {writePair: (t, c, o, s, v, _io, oldState) => writeUpdatePair(t, c, o, s, v, io, oldState)}), /state rename failed/);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(await readFile(state, "utf8"), snapshot);
    await run(args);
    assert.match(await readFile(target, "utf8"), /DOMAIN, new\.example/);
    assert(JSON.parse(await readFile(state, "utf8")).rules.includes("DOMAIN, new.example"));
  } finally {
    globalThis.fetch = oldFetch;
    await rm(dir, {recursive: true, force: true});
  }
});

test("concurrent full filter updates do not read or write the same target together", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-filter-lock-"));
  const target = path.join(dir, "filter.list"), state = path.join(dir, "state.json");
  const url = "https://raw.githubusercontent.com/example/repo/main/list";
  const original = `# Last Updated: 2026-01-01\n\n# Imported List\n# Source: ${url}\nDOMAIN, old.example\n`;
  const snapshot = `${JSON.stringify(buildSnapshot([{url, rules: parseRuleText("DOMAIN,old.example")}]), null, 2)}\n`;
  const oldFetch = globalThis.fetch; let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async () => {
    started(); await gate;
    const response = new Response("DOMAIN,old.example\nDOMAIN,new.example\n");
    Object.defineProperty(response, "url", {value: url}); return response;
  };
  try {
    await writeFile(target, original); await writeFile(state, snapshot);
    const args = ["--file", target, "--state-file", state, "--allow-large-change"];
    const first = run(args); await ready;
    await assert.rejects(run(args), /Update already running/);
    release(); await first;
    assert.match(await readFile(target, "utf8"), /DOMAIN, new\.example/);
    assert(JSON.parse(await readFile(state, "utf8")).rules.includes("DOMAIN, new.example"));
  } finally { release(); globalThis.fetch = oldFetch; await rm(dir, {recursive: true, force: true}); }
});

test("an external edit during an update is preserved rather than overwritten", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-filter-external-"));
  const target = path.join(dir, "filter.list"), state = path.join(dir, "state.json");
  const url = "https://raw.githubusercontent.com/example/repo/main/list";
  const original = `# Last Updated: 2026-01-01\n\n# Imported List\n# Source: ${url}\nDOMAIN, old.example\n`;
  const snapshot = `${JSON.stringify(buildSnapshot([{url, rules: parseRuleText("DOMAIN,old.example")}]), null, 2)}\n`;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await writeFile(target, original + "# external edit\n");
    const response = new Response("DOMAIN,old.example\nDOMAIN,new.example\n");
    Object.defineProperty(response, "url", {value: url}); return response;
  };
  try {
    await writeFile(target, original); await writeFile(state, snapshot);
    await assert.rejects(run(["--file", target, "--state-file", state, "--allow-large-change"]), /changed since it was read/);
    assert.equal(await readFile(target, "utf8"), original + "# external edit\n");
    assert.equal(await readFile(state, "utf8"), snapshot);
  } finally { globalThis.fetch = oldFetch; await rm(dir, {recursive: true, force: true}); }
});

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

test("inserts and replaces the filter update date", () => {
  const filter = "#AI Generated\n\nDOMAIN, example.com\n";
  const dated = setFilterUpdatedDate(filter, "2026-10-13");

  assert.equal(dated.startsWith("#AI Generated\n# Last Updated: 2026-10-13\n"), true);
  assert.equal(
    setFilterUpdatedDate(dated, "2026-10-14").includes("# Last Updated: 2026-10-14"),
    true,
  );
  assert.equal(
    setFilterUpdatedDate(dated, "2026-10-14").match(/^# Last Updated:/gmu)?.length,
    1,
  );
});
