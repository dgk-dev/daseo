import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  daemonInstallOriginRuntime,
  validateDaemonInstallOrigin,
  type DaemonInstallOriginRuntime,
} from "./install-origin.js";
import { randomUUID } from "node:crypto";
import { npmGlobalPaseoCli, type NpmGlobalPaseoCli } from "./npm-global-cli.js";
import { armDaemonUpdateRollbackWatchdog, DaemonUpdateTrialStore } from "./daemon-update-trial.js";

export type DaemonSelfUpdatePhase = "starting" | "downloading" | "installing" | "complete";

export interface DaemonSelfUpdateResult {
  success: boolean;
  error: string | null;
  newVersion: string | null;
  updateId?: string | null;
  targetVersion?: string | null;
  rolledBack?: boolean;
}

export interface DaemonSelfUpdateInput {
  daemonVersion: string | null;
  desktopManaged: boolean;
  onProgress: (phase: DaemonSelfUpdatePhase) => void;
  logger: DaemonSelfUpdateLogger;
  paseoHome?: string;
  updateId?: string;
}

export interface DaemonSelfUpdateLogger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface DaemonSelfUpdateRuntime {
  npm: NpmGlobalPaseoCli;
  installOrigin: DaemonInstallOriginRuntime;
  armRollbackWatchdog?: typeof armDaemonUpdateRollbackWatchdog;
}

export class DaemonSelfUpdateInProgressError extends Error {
  constructor() {
    super("An update is already in progress");
    this.name = "DaemonSelfUpdateInProgressError";
  }
}

const defaultRuntime: DaemonSelfUpdateRuntime = {
  npm: npmGlobalPaseoCli,
  installOrigin: daemonInstallOriginRuntime,
  armRollbackWatchdog: armDaemonUpdateRollbackWatchdog,
};

const DESKTOP_MANAGED_UPDATE_ERROR =
  "This daemon is managed by Paseo Desktop. Update Paseo Desktop on the host.";

export class DaemonSelfUpdater {
  private inProgress = false;

  constructor(private readonly runtime: DaemonSelfUpdateRuntime = defaultRuntime) {}

  async update(input: DaemonSelfUpdateInput): Promise<DaemonSelfUpdateResult> {
    if (input.desktopManaged) return this.failure(DESKTOP_MANAGED_UPDATE_ERROR);
    if (this.inProgress) throw new DaemonSelfUpdateInProgressError();
    this.inProgress = true;
    try {
      return await this.runUpdate(input);
    } finally {
      this.inProgress = false;
    }
  }

  private async runUpdate(input: DaemonSelfUpdateInput): Promise<DaemonSelfUpdateResult> {
    const updateId = input.updateId ?? randomUUID();
    const trialStore = input.paseoHome ? new DaemonUpdateTrialStore(input.paseoHome) : null;
    let prepared: { previousVersion: string; targetVersion: string } | null = null;
    let installSucceeded = false;
    try {
      const preparation = await this.prepareUpdate(input, updateId, trialStore);
      if ("result" in preparation) return preparation.result;
      prepared = preparation;
      if (prepared.targetVersion === prepared.previousVersion) {
        input.onProgress("complete");
        return this.success(updateId, prepared.targetVersion);
      }
      installSucceeded = true;
      const installedVersion = await this.installAndVerify(input, updateId, prepared, trialStore);
      input.onProgress("complete");
      return this.success(updateId, installedVersion);
    } catch (error) {
      return await this.recoverFailedUpdate({
        input,
        updateId,
        prepared,
        installSucceeded,
        trialStore,
        error,
      });
    }
  }

  private async prepareUpdate(
    input: DaemonSelfUpdateInput,
    updateId: string,
    trialStore: DaemonUpdateTrialStore | null,
  ): Promise<
    { previousVersion: string; targetVersion: string } | { result: DaemonSelfUpdateResult }
  > {
    input.onProgress("starting");
    const install = await this.runtime.npm.inspect();
    const previousVersion = input.daemonVersion ?? install.version;
    const unsupportedReason = validateDaemonInstallOrigin(
      install,
      input.daemonVersion,
      this.runtime.installOrigin,
    );
    if (unsupportedReason) return { result: this.failure(unsupportedReason) };
    const targetVersion = this.runtime.npm.resolveLatestVersion
      ? await this.runtime.npm.resolveLatestVersion()
      : "latest";
    if (targetVersion === previousVersion) return { previousVersion, targetVersion };

    input.onProgress("downloading");
    const preflight = this.runtime.npm.preflightVersion
      ? await this.runtime.npm.preflightVersion(targetVersion)
      : null;
    if (preflight && preflight.exitCode !== 0) {
      const error = preflight.stderr.trim() || preflight.stdout.trim() || "Update preflight failed";
      return { result: this.failure(error, updateId, targetVersion) };
    }
    await trialStore?.prepare({ updateId, previousVersion, targetVersion });
    return { previousVersion, targetVersion };
  }

  private async installAndVerify(
    input: DaemonSelfUpdateInput,
    updateId: string,
    prepared: { previousVersion: string; targetVersion: string },
    trialStore: DaemonUpdateTrialStore | null,
  ): Promise<string> {
    input.onProgress("installing");
    const result = this.runtime.npm.installVersion
      ? await this.runtime.npm.installVersion(prepared.targetVersion)
      : await this.runtime.npm.installLatest();
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `npm exited with code ${result.exitCode}`,
      );
    }
    const updatedInstall = await this.runtime.npm.inspect();
    if (prepared.targetVersion !== "latest" && updatedInstall.version !== prepared.targetVersion) {
      throw new Error(
        `Installed daemon version ${updatedInstall.version}; expected ${prepared.targetVersion}`,
      );
    }
    await trialStore?.transition("installed");
    if (input.paseoHome && this.runtime.armRollbackWatchdog) {
      this.runtime.armRollbackWatchdog({
        paseoHome: input.paseoHome,
        updateId,
        previousVersion: prepared.previousVersion,
      });
    }
    return updatedInstall.version;
  }

  private async recoverFailedUpdate(input: {
    input: DaemonSelfUpdateInput;
    updateId: string;
    prepared: { previousVersion: string; targetVersion: string } | null;
    installSucceeded: boolean;
    trialStore: DaemonUpdateTrialStore | null;
    error: unknown;
  }): Promise<DaemonSelfUpdateResult> {
    const message = getErrorMessage(input.error);
    input.input.logger.error(
      { err: input.error, updateId: input.updateId, targetVersion: input.prepared?.targetVersion },
      "Daemon self-update failed with exception",
    );
    const npm = this.runtime.npm;
    if (input.installSucceeded && input.prepared && npm.installVersion) {
      const rollback = await npm.installVersion(input.prepared.previousVersion);
      const rolledBack = rollback.exitCode === 0;
      await input.trialStore?.transition(rolledBack ? "rolled_back" : "failed", message);
      return {
        ...this.failure(message, input.updateId, input.prepared.targetVersion),
        rolledBack,
      };
    }
    await input.trialStore?.transition("failed", message);
    return this.failure(message, input.updateId, input.prepared?.targetVersion ?? null);
  }

  private success(updateId: string, version: string): DaemonSelfUpdateResult {
    return {
      success: true,
      error: null,
      newVersion: version,
      updateId,
      targetVersion: version,
      rolledBack: false,
    };
  }

  private failure(
    error: string,
    updateId: string | null = null,
    targetVersion: string | null = null,
  ): DaemonSelfUpdateResult {
    return {
      success: false,
      error,
      newVersion: null,
      updateId,
      targetVersion,
      rolledBack: false,
    };
  }
}

export const daemonSelfUpdater = new DaemonSelfUpdater();
