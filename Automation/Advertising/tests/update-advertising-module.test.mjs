import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { recoverUpdatePair, withUpdateLock } from "../../write-update-pair.mjs";

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
  writeUpdatePair,
} from "../update-advertising-module.mjs";

const SOURCE = "https://raw.githubusercontent.com/example/repo/main/module.sgmodule";

test("the actual Advertising module contains no denied MITM hosts", () => {
  const text = readFileSync(new URL("../../../Rewrite/Advertising.sgmodule", import.meta.url), "utf8");
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
  const hash = createHash("sha256").update(JSON.stringify({version: 2,
    currentHosts: [...current].sort(), proposedHosts: [...next].sort(), currentRules: [], proposedRules: []})).digest("hex");
  assert.throws(() => requireReviewedMitmAdditions(current, next), (error) => error.message.includes(hash));
  assert.deepEqual(current, ["keep.example", "manual.example"]);
  assert.deepEqual(requireReviewedMitmAdditions(current, next, hash), ["*.new.example", "api.example:8443"]);
  assert.deepEqual(requireReviewedMitmAdditions(current, [...next].reverse(), hash), ["*.new.example", "api.example:8443"]);
  assert.throws(() => requireReviewedMitmAdditions(current, [...next, "later.example"], hash), /require review/u);
  assert.throws(() => requireReviewedMitmAdditions(current, next.slice(0, -1), hash), /require review/u);
  assert.throws(() => requireReviewedMitmAdditions(current, next.filter(x => x !== "manual.example"), hash), /require review/u);
  assert.throws(() => requireReviewedMitmAdditions(current, next, hash, [], ["^https://ads.example/ - reject"]), /require review/u);
  assert.throws(() => requireReviewedMitmAdditions(current, next, "bad"), /lowercase SHA-256/u);
  assert.throws(() => requireReviewedMitmAdditions(current, current, hash), /require review/u);
  assert.throws(() => assertNoDeniedMitmHosts([...current, "m.airchina.com.cn"]), /denied MITM/u);
  assert.deepEqual(requireReviewedMitmAdditions(current, ["keep.example"]), []);
});

test("paired update stages both files and rolls back after a second rename failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-pair-test-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state");
  const reset = async () => { await writeFile(target, "original module"); await writeFile(state, "original state"); };
  try {
    await reset();
    const stageFailure = {writeFile: async (file, ...args) => {
      if (file.startsWith(`${state}.tmp-`)) throw new Error("state staging failed");
      return writeFile(file, ...args);
    }, rename, unlink};
    await assert.rejects(writeUpdatePair(target, "new module", "original module", state, "new state", stageFailure), /staging failed/);
    assert.equal(await readFile(target, "utf8"), "original module");
    assert.equal(await readFile(state, "utf8"), "original state");
    const renameFailure = {writeFile, unlink, rename: async (from, to) => {
      if (to === state) throw new Error("state rename failed");
      return rename(from, to);
    }};
    await assert.rejects(writeUpdatePair(target, "new module", "original module", state, "new state", renameFailure), /state rename failed/);
    assert.equal(await readFile(target, "utf8"), "original module");
    assert.equal(await readFile(state, "utf8"), "original state");
    const rollbackFailure = {writeFile, unlink, rename: async (from, to) => {
      if (to === state || from.endsWith("-backup")) throw new Error("rename blocked");
      return rename(from, to);
    }};
    await assert.rejects(writeUpdatePair(target, "new module", "original module", state, "new state", rollbackFailure), /rollback failed/);
    const backups = (await readdir(dir)).filter(name => name.startsWith("module.tmp-") && name.endsWith("-backup"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(dir, backups[0]), "utf8"), "original module");
    assert.equal(await readFile(state, "utf8"), "original state");
    await assert.rejects(writeUpdatePair(target, "other", "new module", state, "other"), /requires recovery/);
    assert.equal(await recoverUpdatePair(target, state), "rolled-back");
    await reset();
    await writeUpdatePair(target, "new module", "original module", state, "new state");
    assert.equal(await readFile(target, "utf8"), "new module");
    assert.equal(await readFile(state, "utf8"), "new state");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("concurrent writers fail safely across tasks and processes without mismatched files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-writer-lock-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state");
  try {
    await writeFile(target, "old"); await writeFile(state, "old");
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const io = {rename, unlink, writeFile: async (file, ...args) => {
      if (file.startsWith(`${state}.tmp-`)) { started(); await gate; }
      return writeFile(file, ...args);
    }};
    const first = writeUpdatePair(target, "A", "old", state, "A", io, "old");
    await ready;
    await assert.rejects(writeUpdatePair(target, "B", "old", state, "B", undefined, "old"), /Update already running/);
    const moduleUrl = pathToFileURL(path.resolve("Automation/write-update-pair.mjs")).href;
    const code = `import {writeUpdatePair} from ${JSON.stringify(moduleUrl)}; try {await writeUpdatePair(${JSON.stringify(target)},'B','old',${JSON.stringify(state)},'B'); process.exitCode=1} catch(e) {console.log(e.message)}`;
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code]);
    assert.match(child.stdout, /Update already running/);
    release(); await first;
    assert.equal(await readFile(target, "utf8"), "A"); assert.equal(await readFile(state, "utf8"), "A");
    await assert.rejects(writeUpdatePair(target, "B", "old", state, "B", undefined, "old"), /changed since it was read/);
    assert.equal(await readFile(target, "utf8"), "A"); assert.equal(await readFile(state, "utf8"), "A");
    assert.equal((await readdir(dir)).some(name => name.endsWith(".update.lock")), false);
    await withUpdateLock(target, () => writeUpdatePair(target, "C", "A", state, "C", undefined, "A"));
    assert.equal(await readFile(state, "utf8"), "C");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a changed source snapshot aborts without overwriting either file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-stale-state-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state");
  try {
    await writeFile(target, "original"); await writeFile(state, "newer");
    await assert.rejects(writeUpdatePair(target, "updated", "original", state, "updated", undefined, "older"), /changed since it was read/);
    assert.equal(await readFile(target, "utf8"), "original"); assert.equal(await readFile(state, "utf8"), "newer");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("SIGKILL at either rename leaves recoverable, validated journal evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-crash-recovery-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state");
  const moduleUrl = pathToFileURL(path.resolve("Automation/write-update-pair.mjs")).href;
  try {
    for (const phase of ["before-target", "after-target", "after-state"]) {
      await writeFile(target, "old"); await writeFile(state, "old");
      const code = `import {writeFile,rename,unlink} from 'node:fs/promises';import {writeUpdatePair} from ${JSON.stringify(moduleUrl)};const target=${JSON.stringify(target)},state=${JSON.stringify(state)},phase=${JSON.stringify(phase)};await writeUpdatePair(target,'new','old',state,'new',{writeFile,unlink,rename:async(a,b)=>{if(phase==='before-target'&&b===target)process.kill(process.pid,'SIGKILL');await rename(a,b);if((phase==='after-target'&&b===target)||(phase==='after-state'&&b===state))process.kill(process.pid,'SIGKILL')}},'old')`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], {stdio: "ignore"});
      assert.equal(await new Promise(resolve => child.on("exit", (_code, signal) => resolve(signal))), "SIGKILL");
      await assert.rejects(writeUpdatePair(target, "other", "old", state, "other"), /stale lock/);
      const result = await recoverUpdatePair(target, state);
      const expected = phase === "after-state" ? "new" : "old";
      assert.equal(result, phase === "after-state" ? "completed" : "rolled-back");
      assert.equal(await readFile(target, "utf8"), expected); assert.equal(await readFile(state, "utf8"), expected);
      assert.deepEqual((await readdir(dir)).sort(), ["module", "state"]);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("recovery preserves changed files and refuses active locks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-unsafe-recovery-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state");
  try {
    await writeFile(target, "old"); await writeFile(state, "old");
    await withUpdateLock(target, async () => assert.rejects(recoverUpdatePair(target, state), /still running/));
    const io = {writeFile, unlink, rename: async (from, to) => {
      if (to === state || from.endsWith("-backup")) throw new Error("rename blocked");
      return rename(from, to);
    }};
    await assert.rejects(writeUpdatePair(target, "new", "old", state, "new", io, "old"), /rollback failed/);
    await writeFile(state, "external edit");
    await assert.rejects(recoverUpdatePair(target, state), /differ from journal/);
    assert.equal(await readFile(target, "utf8"), "new"); assert.equal(await readFile(state, "utf8"), "external edit");
    assert((await readdir(dir)).some(name => name.endsWith(".update.journal")));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("corrupt recovery artifacts are rejected before either target is modified", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-corrupt-recovery-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state");
  try {
    await writeFile(target, "old"); await writeFile(state, "old");
    const io = {writeFile, unlink, rename: async (from, to) => {
      if (to === state || from.endsWith("-backup")) throw new Error("rename blocked");
      return rename(from, to);
    }};
    await assert.rejects(writeUpdatePair(target, "new", "old", state, "new", io, "old"), /rollback failed/);
    const staged = (await readdir(dir)).find(name => name.startsWith("state.tmp-"));
    assert(staged); await writeFile(path.join(dir, staged), "external edit");
    await assert.rejects(recoverUpdatePair(target, state), /artifact changed/);
    assert.equal(await readFile(target, "utf8"), "new"); assert.equal(await readFile(state, "utf8"), "old");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("an external target edit during a failed commit is not overwritten by rollback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-rollback-edit-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state");
  try {
    await writeFile(target, "old"); await writeFile(state, "old");
    const io = {writeFile, unlink, rename: async (from, to) => {
      if (to === state) { await writeFile(target, "external edit"); throw new Error("state rename failed"); }
      return rename(from, to);
    }};
    await assert.rejects(writeUpdatePair(target, "new", "old", state, "new", io, "old"), /rollback failed/);
    assert.equal(await readFile(target, "utf8"), "external edit");
    assert.equal(await readFile(state, "utf8"), "old");
    await assert.rejects(recoverUpdatePair(target, state), /differ from journal/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("an interrupted recovery remains fail-closed and can resume after its guard is verified stale", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-recovery-killed-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state");
  try {
    await writeFile(target, "old"); await writeFile(state, "old");
    const io = {writeFile, unlink, rename: async (from, to) => {
      if (to === state || from.endsWith("-backup")) throw new Error("rename blocked");
      return rename(from, to);
    }};
    await assert.rejects(writeUpdatePair(target, "new", "old", state, "new", io, "old"), /rollback failed/);
    const moduleUrl = pathToFileURL(path.resolve("Automation/write-update-pair.mjs")).href;
    const code = `import {rename} from 'node:fs/promises';import {recoverUpdatePair} from ${JSON.stringify(moduleUrl)};await recoverUpdatePair(${JSON.stringify(target)},${JSON.stringify(state)},{rename:async(a,b)=>{await rename(a,b);process.kill(process.pid,'SIGKILL')}})`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {stdio: "ignore"});
    assert.equal(await new Promise(resolve => child.on("exit", (_code, signal) => resolve(signal))), "SIGKILL");
    await assert.rejects(recoverUpdatePair(target, state), error => error.code === "EEXIST");
    assert.equal(await readFile(target, "utf8"), "old"); assert.equal(await readFile(state, "utf8"), "old");
    // Only after this test's child is confirmed dead can its recovery guard be removed.
    await unlink(`${target}.update.recover`);
    assert.equal(await recoverUpdatePair(target, state), "rolled-back");
    assert.deepEqual((await readdir(dir)).sort(), ["module", "state"]);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("missing journals preserve a dead owner's lock and both versions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-missing-journal-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state"), lock = `${target}.update.lock`;
  try {
    for (const text of ["old", "new"]) {
      await writeFile(target, text); await writeFile(state, text);
      const code = `require('fs').writeFileSync(${JSON.stringify(lock)},JSON.stringify({version:1,pid:process.pid,host:require('os').hostname()}))`;
      await promisify(execFile)(process.execPath, ["-e", code]);
      const priorLock = await readFile(lock, "utf8");
      await assert.rejects(recoverUpdatePair(target, state), e => /Recovery journal missing/.test(e.message) && e.code === "ENOENT" && e.cause?.code === "ENOENT");
      assert.equal(await readFile(lock, "utf8"), priorLock);
      assert.equal(await readFile(target, "utf8"), text); assert.equal(await readFile(state, "utf8"), text);
      await assert.rejects(writeUpdatePair(target, "newer", text, state, "newer"), /stale lock/);
      await unlink(lock);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("an existing recovery guard is preserved and reported without guessing ownership", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-guard-diagnostic-"));
  const target = path.join(dir, "module"), state = path.join(dir, "state"), guard = `${target}.update.recover`;
  try {
    await writeFile(target, "old"); await writeFile(state, "old"); await writeFile(guard, "existing");
    await assert.rejects(recoverUpdatePair(target, state), e => /Recovery already running or stale recovery guard/.test(e.message) && e.code === "EEXIST" && e.cause?.code === "EEXIST");
    assert.equal(await readFile(guard, "utf8"), "existing");
    assert.equal(await readFile(target, "utf8"), "old"); assert.equal(await readFile(state, "utf8"), "old");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("MITM fingerprint gates the complete update and rejects changed upstream hosts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "surge-mitm-test-"));
  const target = path.join(dir, "target.sgmodule"), state = path.join(dir, "state.json");
  const rule = "^https://old.example/ - reject";
  const initial = renderTargetModule({preamble: `#!name=Fixture\n#!date=2026-01-01\n# Source: ${SOURCE}`, mitmHosts: ["old.example"], urlRewrite: [rule]});
  const snapshot = buildSnapshot([{role: "source", url: SOURCE, mitmHosts: ["old.example"], urlRewrite: [rule]}]);
  const previousFetch = globalThis.fetch;
  let hosts = ["old.example", "new.example"];
  let rules = [rule, "^https://new.example/ - reject"];
  const mockFetch = async () => new Response(renderTargetModule({preamble: "#!name=Source", mitmHosts: hosts, urlRewrite: rules}), {status: 200});
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
    rules = [...rules, "^https://later.example/ - reject"];
    await assert.rejects(run([...args, "--approved-mitm-sha256", fingerprint]), /require review/u);
    assert.equal(await readFile(target, "utf8"), initial);
    assert.equal(await readFile(state, "utf8"), initialState);
    rules = [rule, "^https://new.example/ - reject"];
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
