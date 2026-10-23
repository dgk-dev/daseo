import { ipcMain, shell } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  expandLocalPath,
  getSystemOpenKind,
  isAllowedExternalUrl,
  openLocalPath,
  registerOpenerHandlers,
} from "./opener";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(async () => "") },
}));

function getRegisteredOpenUrlHandler(): (_event: unknown, url: unknown) => Promise<void> {
  registerOpenerHandlers();
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => {
    return channel === "paseo:opener:openUrl";
  })?.[1];
  if (typeof handler !== "function") {
    throw new Error("open URL handler was not registered");
  }
  return handler as (_event: unknown, url: unknown) => Promise<void>;
}

describe("desktop opener", () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
    vi.mocked(shell.openExternal).mockReset();
  });

  it("allows only http and https external URLs", () => {
    expect(isAllowedExternalUrl("https://example.com/path")).toBe(true);
    expect(isAllowedExternalUrl("http://localhost:8081")).toBe(true);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("paseo://settings")).toBe(false);
    expect(isAllowedExternalUrl("/relative/path")).toBe(false);
    expect(isAllowedExternalUrl(null)).toBe(false);
  });

  it("opens allowed URLs through Electron shell", async () => {
    const handler = getRegisteredOpenUrlHandler();

    await handler({}, "https://example.com");

    expect(shell.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("rejects blocked URLs before invoking Electron shell", async () => {
    const handler = getRegisteredOpenUrlHandler();

    await expect(handler({}, "file:///etc/passwd")).rejects.toThrow("Unsupported external URL");

    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("expands home paths and refuses relative ones", () => {
    expect(expandLocalPath("~/paseo-builds/")).toBe(path.join(homedir(), "paseo-builds/"));
    expect(expandLocalPath("/tmp/a/../b.html")).toBe("/tmp/b.html");
    expect(expandLocalPath("docs/report.html")).toBeNull();
  });

  it("opens folders, pages, and documents but never bundles, scripts, or source", () => {
    expect(getSystemOpenKind({ filePath: "/x/out", isDirectory: true, isBundle: false })).toBe(
      "folder",
    );
    expect(
      getSystemOpenKind({ filePath: "/x/Evil.app", isDirectory: true, isBundle: true }),
    ).toBeNull();
    expect(
      getSystemOpenKind({ filePath: "/x/report.HTML", isDirectory: false, isBundle: false }),
    ).toBe("file");
    expect(getSystemOpenKind({ filePath: "/x/a.pdf", isDirectory: false, isBundle: false })).toBe(
      "file",
    );
    for (const name of ["run.sh", "a.command", "main.ts", "notes.md", "app.log", "Makefile"]) {
      expect(
        getSystemOpenKind({ filePath: `/x/${name}`, isDirectory: false, isBundle: false }),
      ).toBeNull();
    }
  });

  it("opens an existing folder and hands everything else back to the file pane", async () => {
    vi.mocked(shell.openPath).mockClear();
    const root = await mkdtemp(path.join(tmpdir(), "daseo-opener-"));
    await mkdir(path.join(root, "Fake.app", "Contents"), { recursive: true });
    await writeFile(path.join(root, "Fake.app", "Contents", "Info.plist"), "");
    await writeFile(path.join(root, "run.command"), "");

    expect(await openLocalPath(root)).toBe("opened");
    expect(shell.openPath).toHaveBeenCalledWith(root);
    expect(await openLocalPath(path.join(root, "Fake.app"))).toBe("not-handled");
    expect(await openLocalPath(path.join(root, "run.command"))).toBe("not-handled");
    expect(await openLocalPath(path.join(root, "missing.pdf"))).toBe("not-handled");
    expect(await openLocalPath(42)).toBe("not-handled");
    expect(shell.openPath).toHaveBeenCalledTimes(1);
  });
});
