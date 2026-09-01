import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { launchDaseoActivationOnce } from "./daseo-activate-once.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Daseo one-shot activation", () => {
  test("launches the activation script once without a launchd supervisor", () => {
    // Given: a release activation script and a process seam that records launches.
    const root = mkdtempSync(path.join(os.tmpdir(), "daseo-activate-once-test-"));
    tempRoots.push(root);
    const scriptPath = path.join(root, "activate.sh");
    writeFileSync(scriptPath, "#!/bin/zsh\nexit 0\n");
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref }));

    // When: the signed release activation is detached from the current agent.
    const pid = launchDaseoActivationOnce({
      scriptPath,
      spawnProcess,
      inheritedEnv: { PATH: "/usr/bin", FORCE_NOW: "1" },
    });

    // Then: one unsupervised zsh process owns the activation and inherited force state cannot
    // bypass the script's idle gate.
    expect(pid).toBe(4242);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith("/bin/zsh", [scriptPath], {
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin" },
    });
    expect(unref).toHaveBeenCalledOnce();
  });

  test("forces immediate activation only when explicitly requested", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "daseo-activate-once-force-test-"));
    tempRoots.push(root);
    const scriptPath = path.join(root, "activate.sh");
    writeFileSync(scriptPath, "#!/bin/zsh\nexit 0\n");
    const spawnProcess = vi.fn(() => ({ pid: 4243, unref: vi.fn() }));

    launchDaseoActivationOnce({
      scriptPath,
      spawnProcess,
      inheritedEnv: { PATH: "/usr/bin" },
      forceNow: true,
    });

    expect(spawnProcess).toHaveBeenCalledWith("/bin/zsh", [scriptPath], {
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin", FORCE_NOW: "1" },
    });
  });
});
