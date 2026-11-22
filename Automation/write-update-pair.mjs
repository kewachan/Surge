import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeUpdatePair(targetPath, content, original, statePath, state, io = {writeFile, rename, unlink}) {
  if (path.resolve(targetPath) === path.resolve(statePath)) throw new Error("Target and state must be different files");
  const targetTemp = `${targetPath}.tmp-${process.pid}-new`;
  const stateTemp = `${statePath}.tmp-${process.pid}-new`;
  const backup = `${targetPath}.tmp-${process.pid}-backup`;
  let targetReplaced = false, preserveBackup = false;
  try {
    await io.writeFile(backup, original, "utf8");
    await io.writeFile(targetTemp, content, "utf8");
    await io.writeFile(stateTemp, state, "utf8");
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
    await Promise.all([targetTemp, stateTemp, ...(preserveBackup ? [] : [backup])].map(file => io.unlink(file).catch(() => {})));
  }
}
