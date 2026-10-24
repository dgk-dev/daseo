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
  shell: { openExternal: vi.fn(), openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
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

  it("opens an existing folder, reveals everything else in Finder, and hands back only a missing path", async () => {
    vi.mocked(shell.openPath).mockClear();
    vi.mocked(shell.showItemInFolder).mockClear();
    const root = await mkdtemp(path.join(tmpdir(), "daseo-opener-"));
    await mkdir(path.join(root, "Fake.app", "Contents"), { recursive: true });
    await writeFile(path.join(root, "Fake.app", "Contents", "Info.plist"), "");
    await writeFile(path.join(root, "run.command"), "");
    await writeFile(path.join(root, "main.ts"), "");

    expect(await openLocalPath(root)).toBe("opened");
    expect(shell.openPath).toHaveBeenCalledWith(root);
    expect(await openLocalPath(path.join(root, "Fake.app"))).toBe("revealed");
    expect(await openLocalPath(path.join(root, "run.command"))).toBe("revealed");
    expect(await openLocalPath(path.join(root, "main.ts"))).toBe("revealed");
    expect(shell.showItemInFolder).toHaveBeenCalledTimes(3);
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(path.join(root, "main.ts"));
    expect(await openLocalPath(path.join(root, "missing.pdf"))).toBe("not-handled");
    expect(await openLocalPath(42)).toBe("not-handled");
    expect(shell.openPath).toHaveBeenCalledTimes(1);
  });

  it("reveals a document in Finder when its app refuses to open it", async () => {
    vi.mocked(shell.openPath).mockClear();
    vi.mocked(shell.showItemInFolder).mockClear();
    vi.mocked(shell.openPath).mockResolvedValueOnce("No application");
    const root = await mkdtemp(path.join(tmpdir(), "daseo-opener-"));
    await writeFile(path.join(root, "report.pdf"), "");

    expect(await openLocalPath(path.join(root, "report.pdf"))).toBe("revealed");
    expect(shell.showItemInFolder).toHaveBeenCalledWith(path.join(root, "report.pdf"));
  });
});
