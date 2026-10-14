import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, promises as fs, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

const DEFAULT_KEPT_CORRUPT_BACKUPS = 3;

export interface PreserveUnreadableFileOptions {
  now?: () => Date;
  keep?: number;
}

interface CorruptBackupTarget {
  directory: string;
  prefix: string;
  backupPath: string;
  keep: number;
}

// 2026-10-15T09:30:12.123Z -> 20261015T093012-123Z. Lexical order is chronological order,
// which is what pruning relies on.
function formatBackupTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 19).replace(/[-:]/g, "")}-${iso.slice(20, 23)}Z`;
}

function resolveCorruptBackupTarget(
  filePath: string,
  options: PreserveUnreadableFileOptions | undefined,
): CorruptBackupTarget {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.corrupt-`;
  const timestamp = formatBackupTimestamp((options?.now ?? (() => new Date()))());
  return {
    directory,
    prefix,
    backupPath: path.join(directory, `${prefix}${timestamp}`),
    keep: Math.max(1, options?.keep ?? DEFAULT_KEPT_CORRUPT_BACKUPS),
  };
}

function selectPrunableBackups(entries: string[], target: CorruptBackupTarget): string[] {
  return entries
    .filter((entry) => entry.startsWith(target.prefix))
    .sort()
    .toReversed()
    .slice(target.keep)
    .map((entry) => path.join(target.directory, entry));
}

/**
 * Copies a persisted file that failed to load to `<file>.corrupt-<timestamp>` before the caller
 * falls back to empty state, so the next write cannot destroy the only copy. Keeps the newest
 * backups (3 by default) and prunes older ones only after the new copy exists. Never restores.
 * Returns the backup path, or null when the source is missing or the copy failed; never throws.
 */
export async function preserveUnreadableFile(
  filePath: string,
  options?: PreserveUnreadableFileOptions,
): Promise<string | null> {
  const target = resolveCorruptBackupTarget(filePath, options);
  try {
    const { mode } = await fs.stat(filePath);
    await fs.copyFile(filePath, target.backupPath);
    if (process.platform !== "win32") {
      await fs.chmod(target.backupPath, mode & 0o777);
    }
  } catch {
    await fs.rm(target.backupPath, { force: true }).catch(() => undefined);
    return null;
  }
  try {
    const entries = await fs.readdir(target.directory);
    for (const stale of selectPrunableBackups(entries, target)) {
      await fs.rm(stale, { force: true });
    }
  } catch {
    // The new backup exists; a failed prune only leaves extra old copies behind.
  }
  return target.backupPath;
}

export function preserveUnreadableFileSync(
  filePath: string,
  options?: PreserveUnreadableFileOptions,
): string | null {
  const target = resolveCorruptBackupTarget(filePath, options);
  try {
    const { mode } = statSync(filePath);
    copyFileSync(filePath, target.backupPath);
    if (process.platform !== "win32") {
      chmodSync(target.backupPath, mode & 0o777);
    }
  } catch {
    try {
      rmSync(target.backupPath, { force: true });
    } catch {
      // Nothing was copied, or the directory is unwritable; either way there is no backup.
    }
    return null;
  }
  try {
    for (const stale of selectPrunableBackups(readdirSync(target.directory), target)) {
      rmSync(stale, { force: true });
    }
  } catch {
    // The new backup exists; a failed prune only leaves extra old copies behind.
  }
  return target.backupPath;
}
