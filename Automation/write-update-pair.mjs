import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";

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
    const locks = new Set(heldLocks.getStore() || []); locks.add(target);
    return await heldLocks.run(locks, action);
  } finally {
    try { await handle.close(); } finally { await unlink(lockPath); }
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
    let targetReplaced = false, preserveBackup = false;
    const created = new Set();
    try {
      await io.writeFile(backup, original, {encoding: "utf8", flag: "wx"});
      created.add(backup);
      await io.writeFile(targetTemp, content, {encoding: "utf8", flag: "wx"});
      created.add(targetTemp);
      await io.writeFile(stateTemp, state, {encoding: "utf8", flag: "wx"});
      created.add(stateTemp);
      await assertInputsUnchanged(targetPath, original, statePath, originalState, io.readFile || readFile);
      await io.rename(targetTemp, targetPath);
      targetReplaced = true;
      await io.rename(stateTemp, statePath);
    } catch (error) {
      if (targetReplaced) {
        try { await io.rename(backup, targetPath); }
        catch (rollbackError) {
          preserveBackup = true;
          throw new Error(`State update failed; target rollback failed. Original target retained at ${backup}: ${rollbackError.message}`, {cause: error});
        }
      }
      throw error;
    } finally {
      await Promise.all([...created].filter(file => !preserveBackup || file !== backup).map(file => io.unlink(file).catch(() => {})));
    }
  });
}
