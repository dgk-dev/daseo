import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const TrialSchema = z.object({
  version: z.literal(1),
  updateId: z.string(),
  previousVersion: z.string(),
  targetVersion: z.string(),
  status: z.enum(["prepared", "installed", "committed", "rolled_back", "failed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  snapshotDirectory: z.string(),
  error: z.string().nullable(),
});

export type DaemonUpdateTrial = z.infer<typeof TrialSchema>;

const SNAPSHOT_PATHS = [
  "config.json",
  "daemon-keypair.json",
  "device-pairings.json",
  "push-tokens.json",
  "projects/projects.json",
  "projects/workspaces.json",
] as const;

export class DaemonUpdateTrialStore {
  private readonly filePath: string;
  private readonly root: string;

  constructor(private readonly paseoHome: string) {
    this.root = join(paseoHome, "updates");
    this.filePath = join(this.root, "current.json");
  }

  async prepare(input: {
    updateId: string;
    previousVersion: string;
    targetVersion: string;
    now?: Date;
  }): Promise<DaemonUpdateTrial> {
    const now = input.now ?? new Date();
    const snapshotDirectory = join(this.root, input.updateId, "snapshot");
    await rm(join(this.root, input.updateId), { recursive: true, force: true });
    await mkdir(snapshotDirectory, { recursive: true });
    for (const relativePath of SNAPSHOT_PATHS) {
      const destination = join(snapshotDirectory, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(this.paseoHome, relativePath), destination, {
        recursive: true,
        force: true,
        errorOnExist: false,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const trial: DaemonUpdateTrial = {
      version: 1,
      updateId: input.updateId,
      previousVersion: input.previousVersion,
      targetVersion: input.targetVersion,
      status: "prepared",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      snapshotDirectory,
      error: null,
    };
    await this.write(trial);
    return trial;
  }

  async read(): Promise<DaemonUpdateTrial | null> {
    try {
      return TrialSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async transition(
    status: DaemonUpdateTrial["status"],
    error: string | null = null,
  ): Promise<DaemonUpdateTrial | null> {
    const existing = await this.read();
    if (!existing) return null;
    const next = { ...existing, status, error, updatedAt: new Date().toISOString() };
    await this.write(next);
    return next;
  }

  private async write(trial: DaemonUpdateTrial): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeJsonFileAtomic(this.filePath, trial);
  }
}

export function armDaemonUpdateRollbackWatchdog(input: {
  paseoHome: string;
  updateId: string;
  previousVersion: string;
  timeoutMs?: number;
}): void {
  const marker = join(input.paseoHome, "updates", "current.json");
  const script = `
const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const [marker, previousVersion, updateId, timeoutText] = process.argv.slice(1);
setTimeout(() => {
  let trial;
  try { trial = JSON.parse(readFileSync(marker, "utf8")); } catch { return; }
  if (trial.updateId !== updateId || ["committed", "rolled_back"].includes(trial.status)) return;
  const result = spawnSync("npm", ["install", "-g", "@getpaseo/cli@" + previousVersion], { encoding: "utf8" });
  trial.status = result.status === 0 ? "rolled_back" : "failed";
  trial.updatedAt = new Date().toISOString();
  trial.error = result.status === 0 ? "Target daemon did not reach readiness before watchdog timeout" : (result.stderr || "Rollback npm install failed");
  const temp = marker + ".watchdog.tmp";
  writeFileSync(temp, JSON.stringify(trial, null, 2) + "\\n", { mode: 0o600 });
  renameSync(temp, marker);
}, Number(timeoutText));
`;
  const child = spawn(
    process.execPath,
    [
      "-e",
      script,
      marker,
      input.previousVersion,
      input.updateId,
      String(input.timeoutMs ?? 45_000),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

export async function commitPreparedDaemonUpdate(input: {
  paseoHome: string;
  daemonVersion: string | null;
}): Promise<DaemonUpdateTrial | null> {
  const store = new DaemonUpdateTrialStore(input.paseoHome);
  const trial = await store.read();
  if (!trial || trial.status !== "installed") return trial;
  if (input.daemonVersion !== trial.targetVersion) {
    return await store.transition(
      "failed",
      `Started daemon version ${input.daemonVersion ?? "unknown"}; expected ${trial.targetVersion}`,
    );
  }
  return await store.transition("committed");
}
