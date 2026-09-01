import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  DaemonSelfUpdateInProgressError,
  DaemonSelfUpdater,
  type DaemonSelfUpdateRuntime,
  type DaemonSelfUpdatePhase,
} from "./daemon-self-updater.js";
import type { CommandResult, NpmGlobalPaseoInstall } from "./npm-global-cli.js";
import { DaemonUpdateTrialStore } from "./daemon-update-trial.js";

interface TestLogger {
  errors: Array<{ obj: object; msg?: string }>;
  warnings: Array<{ obj: object; msg?: string }>;
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

type Inspection = NpmGlobalPaseoInstall | Error;
type RuntimeCall = "inspect" | "installLatest";

const globalRoot = "/global/lib";
const globalNodeModules = `${globalRoot}/node_modules`;
const cliPackagePath = `${globalNodeModules}/@getpaseo/cli`;
const npmServerPackageRoot = `${cliPackagePath}/node_modules/@getpaseo/server`;
const sourceServerPackageRoot = "/repo/packages/server";
const SERVER_UPDATE_ID = "00000000-0000-4000-8000-000000000094";
const ORIGINAL_DASEO_DISTRIBUTION = process.env.DASEO_DISTRIBUTION;

beforeEach(() => {
  delete process.env.DASEO_DISTRIBUTION;
});

afterAll(() => {
  if (ORIGINAL_DASEO_DISTRIBUTION === undefined) {
    delete process.env.DASEO_DISTRIBUTION;
  } else {
    process.env.DASEO_DISTRIBUTION = ORIGINAL_DASEO_DISTRIBUTION;
  }
});

function npmGlobalPaseoInstall(
  version: string,
  options?: { linked?: boolean },
): NpmGlobalPaseoInstall {
  return {
    version,
    packagePath: cliPackagePath,
    globalRootPath: globalRoot,
    isLinked: options?.linked === true,
  };
}

function createLogger(): TestLogger {
  return {
    errors: [],
    warnings: [],
    error(obj, msg) {
      this.errors.push({ obj, msg });
    },
    warn(obj, msg) {
      this.warnings.push({ obj, msg });
    },
  };
}

function createRuntime(input: {
  inspections: Inspection[];
  currentServerPackageRoot?: string | null;
  installResult?: CommandResult;
  calls?: RuntimeCall[];
}): DaemonSelfUpdateRuntime {
  const calls = input.calls ?? [];
  return {
    npm: {
      async inspect() {
        calls.push("inspect");
        const inspection = input.inspections.shift();
        if (!inspection) {
          throw new Error("Unexpected npm global install inspection");
        }
        if (inspection instanceof Error) {
          throw inspection;
        }
        return inspection;
      },
      async installLatest() {
        calls.push("installLatest");
        return input.installResult ?? { exitCode: 0, stdout: "changed 42 packages", stderr: "" };
      },
    },
    installOrigin: {
      resolveCurrentServerPackageRoot() {
        return input.currentServerPackageRoot ?? npmServerPackageRoot;
      },
    },
  };
}

async function runUpdate(input: {
  runtime: DaemonSelfUpdateRuntime;
  daemonVersion?: string | null;
  desktopManaged?: boolean;
  phases?: DaemonSelfUpdatePhase[];
  paseoHome?: string;
}) {
  const logger = createLogger();
  const updater = new DaemonSelfUpdater(input.runtime);
  const phases = input.phases ?? [];
  const result = await updater.update({
    daemonVersion: input.daemonVersion ?? "0.1.15",
    desktopManaged: input.desktopManaged ?? false,
    onProgress: (phase) => phases.push(phase),
    logger,
    paseoHome: input.paseoHome,
    allowLiveNpmMutation: true,
  });
  return { result, logger, phases };
}

describe("DaemonSelfUpdater", () => {
  test("refuses npm mutation in the Daseo signed-local distribution", async () => {
    process.env.DASEO_DISTRIBUTION = "1";
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({ calls, inspections: [] });

    const { result, phases } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: false,
      error: "Daseo updates use signed local release artifacts.",
      newVersion: null,
      updateId: null,
      targetVersion: null,
      rolledBack: false,
    });
    expect(phases).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("refuses a Desktop-managed daemon without touching npm", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({ calls, inspections: [] });

    const { result, phases } = await runUpdate({ runtime, desktopManaged: true });

    expect(result).toEqual({
      success: false,
      error: "This daemon is managed by Paseo Desktop. Update Paseo Desktop on the host.",
      newVersion: null,
      updateId: null,
      targetVersion: null,
      rolledBack: false,
    });
    expect(phases).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("fails closed before live npm mutation unless explicitly enabled", async () => {
    const calls: RuntimeCall[] = [];
    const updater = new DaemonSelfUpdater(createRuntime({ calls, inspections: [] }));

    await expect(
      updater.update({
        daemonVersion: "0.1.15",
        desktopManaged: false,
        onProgress: () => undefined,
        logger: createLogger(),
      }),
    ).resolves.toEqual({
      success: false,
      error: "Daemon self-update is disabled until staged executable activation is available.",
      newVersion: null,
      updateId: null,
      targetVersion: null,
      rolledBack: false,
    });
    expect(calls).toEqual([]);
  });

  test("updates a daemon that is running from the npm global cli install", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({
      calls,
      inspections: [npmGlobalPaseoInstall("0.1.15"), npmGlobalPaseoInstall("0.1.96")],
    });

    const { result, phases } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: true,
      error: null,
      newVersion: "0.1.96",
      updateId: expect.any(String),
      targetVersion: "0.1.96",
      rolledBack: false,
    });
    expect(phases).toEqual(["starting", "downloading", "installing", "complete"]);
    expect(calls).toEqual(["inspect", "installLatest", "inspect"]);
  });

  test("resolves, preflights, installs, and records one exact target version", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-exact-update-"));
    writeFileSync(join(paseoHome, "config.json"), '{"version":1}');
    const calls: string[] = [];
    const inspections = [npmGlobalPaseoInstall("0.1.15"), npmGlobalPaseoInstall("0.5.0")];
    const runtime: DaemonSelfUpdateRuntime = {
      npm: {
        async inspect() {
          calls.push("inspect");
          return inspections.shift()!;
        },
        async resolveLatestVersion() {
          calls.push("resolve");
          return "0.5.0";
        },
        async preflightVersion(version) {
          calls.push(`preflight:${version}`);
          return { exitCode: 0, stdout: "integrity", stderr: "" };
        },
        async installVersion(version) {
          calls.push(`install:${version}`);
          return { exitCode: 0, stdout: "installed", stderr: "" };
        },
        async installLatest() {
          throw new Error("latest alias must not be installed");
        },
      },
      installOrigin: { resolveCurrentServerPackageRoot: () => npmServerPackageRoot },
      createUpdateId: () => SERVER_UPDATE_ID,
    };
    try {
      const { result } = await runUpdate({ runtime, paseoHome });
      expect(result).toMatchObject({
        success: true,
        newVersion: "0.5.0",
        targetVersion: "0.5.0",
        updateId: SERVER_UPDATE_ID,
      });
      expect(calls).toEqual(["inspect", "resolve", "preflight:0.5.0", "install:0.5.0", "inspect"]);
      await expect(new DaemonUpdateTrialStore(paseoHome).read()).resolves.toMatchObject({
        status: "installed",
        previousVersion: "0.1.15",
        targetVersion: "0.5.0",
      });
    } finally {
      rmSync(paseoHome, { recursive: true, force: true });
    }
  });

  test("rolls back to the exact previous version when post-install verification fails", async () => {
    const installed: string[] = [];
    const inspections = [npmGlobalPaseoInstall("0.1.15"), npmGlobalPaseoInstall("0.5.1")];
    const runtime: DaemonSelfUpdateRuntime = {
      npm: {
        async inspect() {
          return inspections.shift()!;
        },
        async resolveLatestVersion() {
          return "0.5.0";
        },
        async preflightVersion() {
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        async installVersion(version) {
          installed.push(version);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        async installLatest() {
          throw new Error("not used");
        },
      },
      installOrigin: { resolveCurrentServerPackageRoot: () => npmServerPackageRoot },
    };

    const { result } = await runUpdate({ runtime });
    expect(result).toMatchObject({ success: false, rolledBack: true, targetVersion: "0.5.0" });
    expect(result.error).toContain("expected 0.5.0");
    expect(installed).toEqual(["0.5.0", "0.1.15"]);
  });

  test("does not run install when npm global cli is missing", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({
      calls,
      inspections: [new Error("@getpaseo/cli is not installed with npm -g on this host")],
    });

    const { result, phases } = await runUpdate({ runtime });

    expect(result.success).toBe(false);
    expect(result.error).toBe("@getpaseo/cli is not installed with npm -g on this host");
    expect(phases).toEqual(["starting"]);
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update a daemon whose version does not match the npm global cli", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({
      calls,
      inspections: [npmGlobalPaseoInstall("0.1.15")],
    });

    const { result } = await runUpdate({ runtime, daemonVersion: "0.1.96" });

    expect(result).toEqual({
      success: false,
      error:
        "This daemon is not running from the npm global @getpaseo/cli install (global npm has 0.1.15, daemon is 0.1.96).",
      newVersion: null,
      updateId: null,
      targetVersion: null,
      rolledBack: false,
    });
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update a daemon running outside the npm global package tree", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({
      calls,
      currentServerPackageRoot: sourceServerPackageRoot,
      inspections: [npmGlobalPaseoInstall("0.1.15")],
    });

    const { result } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: false,
      error: "This daemon is not running from the npm global @getpaseo/cli install.",
      newVersion: null,
      updateId: null,
      targetVersion: null,
      rolledBack: false,
    });
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update linked global installs", async () => {
    const runtime = createRuntime({
      inspections: [npmGlobalPaseoInstall("0.1.15", { linked: true })],
    });

    const { result } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: false,
      error:
        "The global @getpaseo/cli install is linked; self-update only supports normal npm global installs.",
      newVersion: null,
      updateId: null,
      targetVersion: null,
      rolledBack: false,
    });
  });

  test("rejects concurrent update requests", async () => {
    const calls: RuntimeCall[] = [];
    let resolveInstall: ((result: CommandResult) => void) | null = null;
    let installStartedResolve: (() => void) | null = null;
    const installStarted = new Promise<void>((resolve) => {
      installStartedResolve = resolve;
    });
    const runtime: DaemonSelfUpdateRuntime = {
      npm: {
        async inspect() {
          calls.push("inspect");
          return npmGlobalPaseoInstall("0.1.15");
        },
        async installLatest() {
          calls.push("installLatest");
          installStartedResolve?.();
          return new Promise<CommandResult>((resolve) => {
            resolveInstall = resolve;
          });
        },
      },
      installOrigin: {
        resolveCurrentServerPackageRoot() {
          return npmServerPackageRoot;
        },
      },
    };
    const logger = createLogger();
    const updater = new DaemonSelfUpdater(runtime);

    const firstUpdate = updater.update({
      daemonVersion: "0.1.15",
      desktopManaged: false,
      allowLiveNpmMutation: true,
      onProgress: () => {},
      logger,
    });
    await installStarted;

    await expect(
      updater.update({
        daemonVersion: "0.1.15",
        desktopManaged: false,
        allowLiveNpmMutation: true,
        onProgress: () => {},
        logger,
      }),
    ).rejects.toBeInstanceOf(DaemonSelfUpdateInProgressError);

    resolveInstall?.({ exitCode: 0, stdout: "updated", stderr: "" });
    await expect(firstUpdate).resolves.toMatchObject({ success: true });
    expect(calls).toEqual(["inspect", "installLatest", "inspect"]);
  });
});
