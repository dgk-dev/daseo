import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBrowserPageDialog } from "@/desktop/host";

const host = vi.hoisted(() => ({
  answerPageDialog: vi.fn<(input: unknown) => Promise<boolean>>(),
  watchPageDialogs: vi.fn<() => Promise<unknown[]>>(),
  unsubscribe: vi.fn(),
}));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    browser: {
      answerPageDialog: host.answerPageDialog,
      watchPageDialogs: host.watchPageDialogs,
    },
    events: { on: () => host.unsubscribe },
  }),
}));

import {
  answerPageDialog,
  ensurePageDialogWatch,
  pageDialogWatchState,
  pickShownPageDialog,
  readPageDialogEvent,
  reducePageDialogs,
  selectTabPageDialogs,
  usePageDialogsStore,
  type PageDialogEntry,
} from "./page-dialogs";

const confirm: DesktopBrowserPageDialog = {
  id: "dialog-1",
  type: "confirm",
  message: "Save?",
  openedAt: 1,
  holder: "person",
};

function entry(
  browserId: string,
  rootBrowserId: string,
  dialog: Partial<DesktopBrowserPageDialog> = {},
): PageDialogEntry {
  return { browserId, rootBrowserId, dialog: { ...confirm, ...dialog } };
}

afterEach(() => {
  usePageDialogsStore.setState({ dialogsByBrowserId: {} });
  host.answerPageDialog.mockReset();
});

describe("page dialogs in panes (delta 93)", () => {
  it("keeps one dialog per tab and drops it only for the dialog that closed", () => {
    const shown = reducePageDialogs({}, { browserId: "tab-a", dialog: confirm });
    expect(shown).toEqual({ "tab-a": entry("tab-a", "tab-a") });

    // A late close for an older dialog leaves the newer one.
    expect(
      reducePageDialogs(shown, { browserId: "tab-a", dialog: null, dialogId: "dialog-0" }),
    ).toBe(shown);
    expect(reducePageDialogs(shown, { browserId: "tab-b", dialog: null })).toBe(shown);
    expect(
      reducePageDialogs(shown, { browserId: "tab-a", dialog: null, dialogId: "dialog-1" }),
    ).toEqual({});
  });

  it("updates a dialog an agent took over and ignores an identical repeat", () => {
    const shown = reducePageDialogs({}, { browserId: "tab-a", dialog: confirm });
    expect(reducePageDialogs(shown, { browserId: "tab-a", dialog: { ...confirm } })).toBe(shown);
    const claimed = { ...confirm, holder: "agent" as const, expiresAt: 61_000 };
    expect(reducePageDialogs(shown, { browserId: "tab-a", dialog: claimed })).toEqual({
      "tab-a": { browserId: "tab-a", rootBrowserId: "tab-a", dialog: claimed },
    });
  });

  it("reads only well-formed events from main", () => {
    expect(
      readPageDialogEvent({
        browserId: "tab-a",
        dialog: { ...confirm, defaultValue: "x", url: "https://a.example/", junk: 1 },
      }),
    ).toEqual({
      browserId: "tab-a",
      dialog: { ...confirm, defaultValue: "x", url: "https://a.example/" },
    });
    expect(readPageDialogEvent({ browserId: "tab-a", dialog: null, dialogId: "d" })).toEqual({
      browserId: "tab-a",
      dialog: null,
      dialogId: "d",
    });
    expect(
      readPageDialogEvent({ browserId: "popup-1", rootBrowserId: "tab-a", dialog: confirm }),
    ).toEqual({ browserId: "popup-1", rootBrowserId: "tab-a", dialog: confirm });
    expect(
      readPageDialogEvent({ browserId: "tab-a", dialog: { ...confirm, type: "file" } }),
    ).toBeNull();
    expect(readPageDialogEvent({ dialog: confirm })).toBeNull();
    expect(readPageDialogEvent(null)).toBeNull();
  });
});

describe("the blocking dialog shows whichever side holds it (delta 127)", () => {
  const tabDialogs = (events: Parameters<typeof reducePageDialogs>[1][]) =>
    events.reduce(reducePageDialogs, {} as Record<string, PageDialogEntry>);

  it("a popup's dialog belongs to its tab, other tabs do not see it", () => {
    const state = tabDialogs([
      { browserId: "popup-1", rootBrowserId: "tab-a", dialog: confirm },
      { browserId: "tab-b", dialog: { ...confirm, id: "dialog-2" } },
    ]);
    expect(selectTabPageDialogs(state, "tab-a").map((item) => item.browserId)).toEqual(["popup-1"]);
    expect(selectTabPageDialogs(state, "tab-b").map((item) => item.browserId)).toEqual(["tab-b"]);
  });

  it("with a popup on screen and the opener holding a confirm, the opener's card is shown", () => {
    const state = tabDialogs([{ browserId: "tab-a", dialog: confirm }]);
    const shown = pickShownPageDialog(selectTabPageDialogs(state, "tab-a"), {
      rootBrowserId: "tab-a",
      shownBrowserId: "popup-1",
      popupOrder: ["popup-1"],
    });
    expect(shown?.browserId).toBe("tab-a");
  });

  it("with the tab on screen, an unselected popup's alert is shown", () => {
    const state = tabDialogs([
      { browserId: "popup-2", rootBrowserId: "tab-a", dialog: { ...confirm, type: "alert" } },
    ]);
    const shown = pickShownPageDialog(selectTabPageDialogs(state, "tab-a"), {
      rootBrowserId: "tab-a",
      shownBrowserId: "tab-a",
      popupOrder: ["popup-1", "popup-2"],
    });
    expect(shown).toMatchObject({ browserId: "popup-2", dialog: { type: "alert" } });
  });

  it("several at once: the side on screen, then the tab, then popups in strip order", () => {
    const entries = [
      entry("popup-2", "tab-a", { id: "c", openedAt: 1 }),
      entry("popup-1", "tab-a", { id: "b", openedAt: 2 }),
      entry("tab-a", "tab-a", { id: "a", openedAt: 3 }),
    ];
    const pick = (shownBrowserId: string, list = entries) =>
      pickShownPageDialog(list, {
        rootBrowserId: "tab-a",
        shownBrowserId,
        popupOrder: ["popup-1", "popup-2"],
      })?.browserId;
    expect(pick("popup-2")).toBe("popup-2");
    expect(pick("popup-3")).toBe("tab-a");
    expect(pick("tab-a", entries.slice(0, 2))).toBe("popup-1");
    expect(
      pickShownPageDialog([], { rootBrowserId: "a", shownBrowserId: "a", popupOrder: [] }),
    ).toBe(null);
  });
});

describe("answers main can no longer deliver (delta 127)", () => {
  it("an answer main did not take removes the card", async () => {
    usePageDialogsStore
      .getState()
      .apply({ browserId: "popup-1", rootBrowserId: "tab-a", dialog: confirm });
    host.answerPageDialog.mockResolvedValue(false);
    await expect(
      answerPageDialog({ browserId: "popup-1", dialogId: "dialog-1", accept: true }),
    ).resolves.toBe(false);
    expect(usePageDialogsStore.getState().dialogsByBrowserId).toEqual({});
  });

  it("a rejected answer removes the card too; a delivered one leaves removal to main", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    usePageDialogsStore.getState().apply({ browserId: "tab-a", dialog: confirm });
    host.answerPageDialog.mockResolvedValueOnce(true);
    await expect(
      answerPageDialog({ browserId: "tab-a", dialogId: "dialog-1", accept: true }),
    ).resolves.toBe(true);
    expect(usePageDialogsStore.getState().dialogsByBrowserId["tab-a"]).toBeDefined();

    host.answerPageDialog.mockRejectedValueOnce(new Error("gone"));
    await expect(
      answerPageDialog({ browserId: "tab-a", dialogId: "dialog-1", accept: false }),
    ).resolves.toBe(false);
    expect(usePageDialogsStore.getState().dialogsByBrowserId).toEqual({});
    consoleError.mockRestore();
  });
});

describe("the window's dialog subscription (delta 127)", () => {
  it("a failed watch call is tried again at the next pane mount", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    host.watchPageDialogs.mockRejectedValueOnce(new Error("no handler yet"));
    ensurePageDialogWatch();
    await vi.waitFor(() => expect(pageDialogWatchState()).toBe("idle"));
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);

    host.watchPageDialogs.mockResolvedValueOnce([{ browserId: "tab-a", dialog: confirm }]);
    ensurePageDialogWatch();
    await vi.waitFor(() => expect(pageDialogWatchState()).toBe("started"));
    expect(host.watchPageDialogs).toHaveBeenCalledTimes(2);
    expect(usePageDialogsStore.getState().dialogsByBrowserId["tab-a"]?.dialog).toEqual(confirm);
    ensurePageDialogWatch();
    expect(host.watchPageDialogs).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
