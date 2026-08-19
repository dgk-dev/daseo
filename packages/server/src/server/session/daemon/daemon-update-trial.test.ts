import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { commitPreparedDaemonUpdate, DaemonUpdateTrialStore } from "./daemon-update-trial.js";

const homes: string[] = [];
const UPDATE_ID_1 = "00000000-0000-4000-8000-000000000091";
const UPDATE_ID_2 = "00000000-0000-4000-8000-000000000092";
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function createHome(): string {
  const value = mkdtempSync(join(tmpdir(), "paseo-update-trial-"));
  homes.push(value);
  writeFileSync(join(value, "config.json"), '{"version":1}');
  return value;
}

describe("DaemonUpdateTrialStore", () => {
  test("snapshots durable config and commits only the matching restarted version", async () => {
    const paseoHome = createHome();
    const store = new DaemonUpdateTrialStore(paseoHome);
    const prepared = await store.prepare({
      updateId: UPDATE_ID_1,
      previousVersion: "0.4.2",
      targetVersion: "0.5.0",
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    expect(readFileSync(join(prepared.snapshotDirectory, "config.json"), "utf8")).toBe(
      '{"version":1}',
    );
    await store.transition("installed");
    await expect(
      commitPreparedDaemonUpdate({ paseoHome, daemonVersion: "0.5.0" }),
    ).resolves.toMatchObject({ status: "committed", targetVersion: "0.5.0" });
  });

  test("rejects client-shaped update ids before any recursive filesystem operation", async () => {
    const paseoHome = createHome();
    const store = new DaemonUpdateTrialStore(paseoHome);

    await expect(
      store.prepare({
        updateId: "../../outside",
        previousVersion: "0.4.2",
        targetVersion: "0.5.0",
      }),
    ).rejects.toThrow();
  });

  test("fails the readiness gate when the restarted version is not the target", async () => {
    const paseoHome = createHome();
    const store = new DaemonUpdateTrialStore(paseoHome);
    await store.prepare({
      updateId: UPDATE_ID_2,
      previousVersion: "0.4.2",
      targetVersion: "0.5.0",
    });
    await store.transition("installed");
    await expect(
      commitPreparedDaemonUpdate({ paseoHome, daemonVersion: "0.4.2" }),
    ).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("expected 0.5.0"),
    });
  });
});
