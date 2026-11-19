import { describe, expect, test, vi } from "vitest";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  getPaseoBrowserTabLifecycle,
  setPaseoBrowserPresented,
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWorkspaceId,
  isPaseoBrowserWebviewAttach,
  preparePaseoBrowserWebContents,
  attachedBrowserRegistrationRejection,
  registerAttachedPaseoBrowser,
  unregisterPaseoBrowser,
  unregisterPaseoBrowserFromHost,
} from "./index.js";

class FakeRenderer {
  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return false;
  }
}

class FakeBrowserGuest {
  public readonly backgroundThrottlingCalls: boolean[] = [];
  public readonly cdpCommands: Array<{ command: string; params?: Record<string, unknown> }> = [];
  public readonly debugger = {
    isAttached: () => true,
    attach: () => {},
    sendCommand: async (command: string, params?: Record<string, unknown>) => {
      this.cdpCommands.push({ command, params });
      return {};
    },
  };
  private destroyedListener: (() => void) | null = null;
  private destroyed = false;

  public constructor(
    public readonly id: number,
    public readonly hostWebContents: FakeRenderer,
    public readonly session: object,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public isLoading(): boolean {
    return false;
  }

  public isCurrentlyAudible(): boolean {
    return false;
  }

  public setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingCalls.push(allowed);
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }
}

describe("browser webview attachment", () => {
  test("accepts only allowed URLs on the shared profile partition", () => {
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: PASEO_BROWSER_PROFILE_PARTITION,
      }),
    ).toBe(true);
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: "persist:paseo-browser-tab-a",
      }),
    ).toBe(false);
    expect(
      isPaseoBrowserWebviewAttach({ src: "https://example.com", partition: "persist:foreign" }),
    ).toBe(false);
  });

  test("binds explicit browser identity to the renderer that hosts the guest", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(101, renderer, profileSession);

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(true);
    expect(getPaseoBrowserIdForWebContents(guest)).toBe("browser-a");
    expect(getPaseoBrowserWorkspaceId("browser-a")).toBe("workspace-a");
    unregisterPaseoBrowser("browser-a");
  });

  test("rejects a guest hosted by another renderer", () => {
    const profileSession = {};
    const owner = new FakeRenderer(1);
    const claimant = new FakeRenderer(2);
    const guest = new FakeBrowserGuest(201, owner, profileSession);

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-rejected-owner",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: claimant,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
  });

  // Delta 123: the reason travels to the renderer's rejection and the new_tab error.
  test("names why a guest cannot be registered", () => {
    const profileSession = {};
    const owner = new FakeRenderer(1);
    const claimant = new FakeRenderer(2);
    const guest = new FakeBrowserGuest(401, owner, profileSession);
    const base = {
      browserId: "browser-reason",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      profileSession,
    };

    expect(
      attachedBrowserRegistrationRejection({ ...base, sender: owner, findWebContents: () => null }),
    ).toBe("guest not found");
    expect(
      attachedBrowserRegistrationRejection({
        ...base,
        sender: claimant,
        findWebContents: () => guest,
      }),
    ).toBe("guest belongs to another window");
    expect(
      attachedBrowserRegistrationRejection({
        ...base,
        sender: owner,
        profileSession: {},
        findWebContents: () => guest,
      }),
    ).toBe("guest is not in the browser profile session");
    expect(
      attachedBrowserRegistrationRejection({
        ...base,
        sender: owner,
        findWebContents: () => guest,
      }),
    ).toBeNull();
  });

  test("rejects a guest outside the shared profile", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(301, renderer, {});

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-rejected-profile",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
  });

  test("concurrent windows cannot swap browser identities", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(1);
    const secondRenderer = new FakeRenderer(2);
    const firstGuest = new FakeBrowserGuest(401, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(402, secondRenderer, profileSession);
    const guests = new Map([
      [firstGuest.id, firstGuest],
      [secondGuest.id, secondGuest],
    ]);

    registerAttachedPaseoBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-second",
      webContentsId: secondGuest.id,
      sender: secondRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });
    registerAttachedPaseoBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-first",
      webContentsId: firstGuest.id,
      sender: firstRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });

    expect(getPaseoBrowserIdForWebContents(firstGuest)).toBe("browser-first");
    expect(getPaseoBrowserIdForWebContents(secondGuest)).toBe("browser-second");
    unregisterPaseoBrowser("browser-first");
    unregisterPaseoBrowser("browser-second");
  });

  test("unregisters the same browser only from its requesting host", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(11);
    const secondRenderer = new FakeRenderer(22);
    const firstGuest = new FakeBrowserGuest(501, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(502, secondRenderer, profileSession);

    for (const [renderer, guest] of [
      [firstRenderer, firstGuest],
      [secondRenderer, secondGuest],
    ] as const) {
      registerAttachedPaseoBrowser({
        browserId: "browser-shared-hosts",
        workspaceId: "workspace-shared",
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        findWebContents: () => guest,
      });
    }

    unregisterPaseoBrowserFromHost(firstRenderer.id, "browser-shared-hosts");

    expect(getPaseoBrowserIdForWebContents(firstGuest)).toBeNull();
    expect(getPaseoBrowserIdForWebContents(secondGuest)).toBe("browser-shared-hosts");
    expect(getPaseoBrowserWorkspaceId("browser-shared-hosts")).toBe("workspace-shared");
    unregisterPaseoBrowser("browser-shared-hosts");
  });

  test("prepares throttling once and removes registration when the guest is destroyed", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(31);
    const guest = new FakeBrowserGuest(601, renderer, profileSession);
    preparePaseoBrowserWebContents(guest);
    registerAttachedPaseoBrowser({
      browserId: "browser-cleanup",
      workspaceId: "workspace-cleanup",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(guest.backgroundThrottlingCalls).toEqual([false]);
    expect(getPaseoBrowserIdForWebContents(guest)).toBe("browser-cleanup");

    guest.destroy();

    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
    expect(guest.backgroundThrottlingCalls).toEqual([false]);
  });

  test("holds a presented browser awake, including one presented before it registers", () => {
    const lifecycle = getPaseoBrowserTabLifecycle();
    const release = vi.fn();
    const hold = vi.spyOn(lifecycle, "hold").mockReturnValue(release);
    const profileSession = {};
    const renderer = new FakeRenderer(41);
    const guest = new FakeBrowserGuest(701, renderer, profileSession);
    try {
      setPaseoBrowserPresented({
        hostWebContentsId: 41,
        browserId: "browser-shown",
        presented: true,
      });
      expect(hold).not.toHaveBeenCalled();

      registerAttachedPaseoBrowser({
        browserId: "browser-shown",
        workspaceId: "workspace-shown",
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        findWebContents: () => guest,
      });
      expect(hold).toHaveBeenCalledWith(701);

      setPaseoBrowserPresented({
        hostWebContentsId: 41,
        browserId: "browser-shown",
        presented: true,
      });
      expect(hold).toHaveBeenCalledTimes(1);
      setPaseoBrowserPresented({
        hostWebContentsId: 41,
        browserId: "browser-shown",
        presented: false,
      });
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      hold.mockRestore();
      unregisterPaseoBrowser("browser-shown");
    }
  });

  test("emulates focus for an awake tab off screen, real focus while presented (delta 134)", async () => {
    const lifecycle = getPaseoBrowserTabLifecycle();
    const hold = vi.spyOn(lifecycle, "hold").mockReturnValue(() => {});
    const profileSession = {};
    const renderer = new FakeRenderer(51);
    const guest = new FakeBrowserGuest(801, renderer, profileSession);
    const focusEmulation = () =>
      guest.cdpCommands
        .filter((entry) => entry.command === "Emulation.setFocusEmulationEnabled")
        .map((entry) => entry.params?.enabled);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      preparePaseoBrowserWebContents(guest, { discardable: false });
      await settle();
      // Awake, but where it shows is not known yet: nothing is sent.
      expect(focusEmulation()).toEqual([]);

      registerAttachedPaseoBrowser({
        browserId: "browser-focus",
        workspaceId: "workspace-focus",
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        findWebContents: () => guest,
      });
      await settle();
      expect(focusEmulation()).toEqual([true]);

      setPaseoBrowserPresented({
        hostWebContentsId: 51,
        browserId: "browser-focus",
        presented: true,
      });
      await settle();
      expect(focusEmulation()).toEqual([true, false]);

      setPaseoBrowserPresented({
        hostWebContentsId: 51,
        browserId: "browser-focus",
        presented: false,
      });
      await settle();
      expect(focusEmulation()).toEqual([true, false, true]);
      expect(guest.backgroundThrottlingCalls).toEqual([false]);
    } finally {
      hold.mockRestore();
      guest.destroy();
      unregisterPaseoBrowser("browser-focus");
    }
  });
});
