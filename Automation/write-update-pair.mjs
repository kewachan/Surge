import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const heldLocks = new AsyncLocalStorage();

export async function withUpdateLock(targetPath, action) {
  const target = path.resolve(targetPath);
  if (heldLocks.getStore()?.has(target)) return action();
  const lockPath = `${target}.update.lock`;
  let handle;
  try { handle = await open(lockPath, "wx"); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Update already running or stale lock exists: ${lockPath}`, {cause: error});
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({version: 1, pid: process.pid, host: hostname()}));
    try {
      await readFile(`${target}.update.journal`, "utf8");
      throw new Error(`Interrupted update requires recovery: ${target}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const locks = new Set(heldLocks.getStore() || []); locks.add(target);
    return await heldLocks.run(locks, action);
  } finally {
    try { await handle.close(); } finally { await unlink(lockPath); }
  }
}

const digest = value => createHash("sha256").update(value).digest("hex");

// Explicit recovery never removes an active, foreign-host or unidentified lock.
export async function recoverUpdatePair(targetPath, statePath, io = {rename}) {
  const target = path.resolve(targetPath), state = path.resolve(statePath);
  const lockPath = `${target}.update.lock`, guardPath = `${target}.update.recover`;
  const guard = await open(guardPath, "wx");
  let ownedLock = false;
  try {
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      if (lock.version !== 1 || lock.host !== hostname() || !Number.isSafeInteger(lock.pid) || lock.pid <= 0)
        throw new Error("Lock owner cannot be verified; manual inspection required");
      try { process.kill(lock.pid, 0); throw new Error("Update owner is still running"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const lock = await open(lockPath, "wx"); ownedLock = true;
      try { await lock.writeFile(JSON.stringify({version: 1, pid: process.pid, host: hostname()})); }
      finally { await lock.close(); }
    }
    const journalPath = `${target}.update.journal`;
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    if (journal.version !== 1 || journal.target !== target || journal.state !== state ||
        !/^\d+-[a-f0-9-]{36}$/.test(journal.suffix) ||
        ![journal.oldTarget, journal.oldState, journal.newTarget, journal.newState].every(x => /^[a-f0-9]{64}$/.test(x)))
      throw new Error("Invalid recovery journal; manual inspection required");
    const backup = `${target}.tmp-${journal.suffix}-backup`;
    const targetTemp = `${target}.tmp-${journal.suffix}-new`;
    const stateTemp = `${state}.tmp-${journal.suffix}-new`;
    for (const [file, expected] of [[backup, journal.oldTarget], [targetTemp, journal.newTarget], [stateTemp, journal.newState]]) {
      try { if (digest(await readFile(file)) !== expected) throw new Error(`Recovery artifact changed: ${file}`); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
    }
    let targetHash = digest(await readFile(target));
    const stateHash = digest(await readFile(state));
    if (targetHash === journal.newTarget && stateHash === journal.oldState) {
      if (digest(await readFile(backup)) !== journal.oldTarget) throw new Error("Recovery backup does not match journal");
      await io.rename(backup, target); targetHash = digest(await readFile(target));
    }
    if (!((targetHash === journal.oldTarget && stateHash === journal.oldState) ||
          (targetHash === journal.newTarget && stateHash === journal.newState)))
      throw new Error("Files differ from journal; manual inspection required");
    for (const [file] of [[backup, journal.oldTarget], [targetTemp, journal.newTarget], [stateTemp, journal.newState]]) {
      try { await unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await unlink(journalPath);
    await unlink(lockPath); ownedLock = false;
    return targetHash === journal.newTarget ? "completed" : "rolled-back";
  } finally {
    if (ownedLock) await unlink(lockPath).catch(() => {});
    await guard.close();
    await unlink(guardPath);
  }
}

export async function assertInputsUnchanged(targetPath, original, statePath, originalState, reader = readFile) {
  if (await reader(targetPath, "utf8") !== original ||
      (originalState !== undefined && await reader(statePath, "utf8") !== originalState)) {
    throw new Error("Update aborted: target or source state changed since it was read");
  }
}

export async function writeUpdatePair(targetPath, content, original, statePath, state, io = {writeFile, rename, unlink}, originalState) {
  if (path.resolve(targetPath) === path.resolve(statePath)) throw new Error("Target and state must be different files");
  return withUpdateLock(targetPath, async () => {
    const suffix = `${process.pid}-${randomUUID()}`;
    const targetTemp = `${targetPath}.tmp-${suffix}-new`;
    const stateTemp = `${statePath}.tmp-${suffix}-new`;
    const backup = `${targetPath}.tmp-${suffix}-backup`;
    const journalPath = `${path.resolve(targetPath)}.update.journal`;
    let targetReplaced = false, bothReplaced = false, journalCreated = false, preserveArtifacts = false, expectedState;
    const created = new Set();
    try {
      await io.writeFile(backup, original, {encoding: "utf8", flag: "wx"});
      created.add(backup);
      await io.writeFile(targetTemp, content, {encoding: "utf8", flag: "wx"});
      created.add(targetTemp);
      await io.writeFile(stateTemp, state, {encoding: "utf8", flag: "wx"});
      created.add(stateTemp);
      expectedState = originalState ?? await (io.readFile || readFile)(statePath, "utf8");
      await assertInputsUnchanged(targetPath, original, statePath, expectedState, io.readFile || readFile);
      for (const file of [backup, targetTemp, stateTemp]) {
        const staged = await open(file, "r");
        try { await staged.sync(); } finally { await staged.close(); }
      }
      const journal = await open(journalPath, "wx"); journalCreated = true;
      try {
        await journal.writeFile(JSON.stringify({version: 1, target: path.resolve(targetPath), state: path.resolve(statePath), suffix,
          oldTarget: digest(original), oldState: digest(expectedState), newTarget: digest(content), newState: digest(state)}));
        await journal.sync();
      } finally { await journal.close(); }
      await io.rename(targetTemp, targetPath);
      targetReplaced = true;
      await io.rename(stateTemp, statePath);
      bothReplaced = true;
      await unlink(journalPath); journalCreated = false;
    } catch (error) {
      if (bothReplaced) preserveArtifacts = true;
      else if (targetReplaced) {
        try {
          await assertInputsUnchanged(targetPath, content, statePath, expectedState, io.readFile || readFile);
          await io.rename(backup, targetPath);
        }
        catch (rollbackError) {
          preserveArtifacts = true;
          throw new Error(`State update failed; target rollback failed. Original target retained at ${backup}: ${rollbackError.message}`, {cause: error});
        }
      }
      if (journalCreated && !preserveArtifacts) {
        try { await unlink(journalPath); journalCreated = false; }
        catch (_) { preserveArtifacts = true; }
      }
      throw error;
    } finally {
      if (!preserveArtifacts) await Promise.all([...created].map(file => io.unlink(file).catch(() => {})));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 5 || process.argv[2] !== "--recover") {
    console.error("Usage: node Automation/write-update-pair.mjs --recover <target> <state>");
    process.exitCode = 1;
  } else {
    recoverUpdatePair(process.argv[3], process.argv[4]).then(
      result => console.log(`Recovery: ${result}`),
      error => { console.error(error.message); process.exitCode = 1; },
    );
  }
}
