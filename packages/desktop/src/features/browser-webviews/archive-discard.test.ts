import { afterEach, describe, expect, test, vi } from "vitest";

const electron = vi.hoisted(() => ({
  guests: new Map<number, { id: number; isDestroyed(): boolean; getOSProcessId(): number }>(),
}));
const logInfo = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  webContents: {
    fromId: (id: number) => electron.guests.get(id) ?? null,
    getAllWebContents: () => [...electron.guests.values()],
  },
}));
vi.mock("electron-log/main", () => ({
  default: { info: logInfo, warn: vi.fn(), error: vi.fn() },
}));

const {
  discardPaseoBrowserTabsOfArchivedWorkspace,
  getPaseoBrowserTabLifecycle,
  markPaseoBrowserEdited,
  preparePaseoBrowserWebContents,
  registerAttachedPaseoBrowser,
  trackPaseoBrowserDownload,
  unregisterPaseoBrowser,
} = await import("./index.js");

class FakeRenderer {
  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return false;
  }
}

class FakeGuest {
  public crashed = 0;
  public readonly debugger = {
    isAttached: () => true,
    attach: () => {},
    sendCommand: async () => ({}),
  };
  private destroyedListener: (() => void) | null = null;
  private destroyed = false;

  public constructor(
    public readonly id: number,
    public readonly hostWebContents: FakeRenderer,
    public readonly session: object,
    private readonly pid: number,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public getOSProcessId(): number {
    return this.pid;
  }

  public isLoading(): boolean {
    return false;
  }

  public isCurrentlyAudible(): boolean {
    return false;
  }

  public isCrashed(): boolean {
    return this.crashed > 0;
  }

  public setBackgroundThrottling(): void {}

  public forcefullyCrashRenderer(): void {
    this.crashed += 1;
  }

  public reload(): void {}

  public async executeJavaScriptInIsolatedWorld(): Promise<unknown> {
    return false;
  }

  public on(): this {
    return this;
  }

  public removeListener(): this {
    return this;
  }

  public once(_event: "destroyed", listener: () => void): void {
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }
}

const renderer = new FakeRenderer(9_000);
const profileSession = {};
const browserIds: string[] = [];
const guests: FakeGuest[] = [];

function addTab(input: {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
  pid?: number;
}): FakeGuest {
  const guest = new FakeGuest(
    input.webContentsId,
    renderer,
    profileSession,
    input.pid ?? input.webContentsId,
  );
  electron.guests.set(guest.id, guest);
  guests.push(guest);
  browserIds.push(input.browserId);
  preparePaseoBrowserWebContents(guest, { discardable: true });
  const registered = registerAttachedPaseoBrowser({
    browserId: input.browserId,
    workspaceId: input.workspaceId,
    webContentsId: guest.id,
    sender: renderer,
    profileSession,
    findWebContents: () => guest,
  });
  expect(registered).toBe(true);
  return guest;
}

afterEach(() => {
  for (const browserId of browserIds.splice(0)) unregisterPaseoBrowser(browserId);
  for (const guest of guests.splice(0)) guest.destroy();
  electron.guests.clear();
  logInfo.mockClear();
});

describe("discarding the tabs of an archived workspace (delta 137)", () => {
  test("discards a typed-into tab and a plain tab, leaves other workspaces alone", async () => {
    const edited = addTab({ browserId: "a-edited", workspaceId: "ws-a", webContentsId: 1_001 });
    const plain = addTab({ browserId: "a-plain", workspaceId: "ws-a", webContentsId: 1_002 });
    const other = addTab({ browserId: "b-plain", workspaceId: "ws-b", webContentsId: 1_003 });
    markPaseoBrowserEdited(edited.id);

    await expect(discardPaseoBrowserTabsOfArchivedWorkspace("ws-a")).resolves.toBe(2);

    expect([edited.crashed, plain.crashed, other.crashed]).toEqual([1, 1, 0]);
    const lifecycle = getPaseoBrowserTabLifecycle();
    expect(lifecycle.getState(edited.id)).toBe("discarded");
    expect(lifecycle.getState(other.id)).toBe("active");
    expect(logInfo).toHaveBeenCalledWith("[browser-lifecycle] discarded on workspace archive", {
      browserId: "a-edited",
      webContentsId: edited.id,
      workspaceId: "ws-a",
    });

    // Learning the same archive again ends nothing more.
    await expect(discardPaseoBrowserTabsOfArchivedWorkspace("ws-a")).resolves.toBe(0);
    expect([edited.crashed, plain.crashed]).toEqual([1, 1]);
  });

  test("keeps a downloading tab and a tab whose renderer also runs another page", async () => {
    const downloading = addTab({ browserId: "c-dl", workspaceId: "ws-c", webContentsId: 2_001 });
    const shared = addTab({
      browserId: "c-shared",
      workspaceId: "ws-c",
      webContentsId: 2_002,
      pid: 77,
    });
    addTab({ browserId: "d-shared", workspaceId: "ws-d", webContentsId: 2_003, pid: 77 });
    const finishDownload = trackPaseoBrowserDownload(downloading.id);
    markPaseoBrowserEdited(downloading.id);

    try {
      await expect(discardPaseoBrowserTabsOfArchivedWorkspace("ws-c")).resolves.toBe(0);
      expect([downloading.crashed, shared.crashed]).toEqual([0, 0]);
      expect(logInfo).toHaveBeenCalledWith("[browser-lifecycle] kept on workspace archive", {
        browserId: "c-dl",
        webContentsId: downloading.id,
        workspaceId: "ws-c",
        reason: "downloading",
      });
      expect(logInfo).toHaveBeenCalledWith("[browser-lifecycle] kept on workspace archive", {
        browserId: "c-shared",
        webContentsId: shared.id,
        workspaceId: "ws-c",
        reason: "shared-renderer",
      });
    } finally {
      finishDownload();
    }
  });
});
