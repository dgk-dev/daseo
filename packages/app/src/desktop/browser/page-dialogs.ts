// Daseo delta 93: page dialogs (alert, confirm, prompt) a browser tab holds open, shown inside that
// tab's own pane. Main owns every dialog (packages/desktop/src/features/browser-automation/
// page-dialogs.ts); this window says once that its panes can show them, then keeps one entry per
// browser id from the `browser-page-dialog` event.
//
// Delta 127: each entry also names the tab it belongs to (a popup's dialog belongs to the tab that
// opened it), so the tab's pane shows whichever of the tab or its popups holds a dialog. A dialog
// blocks the page that holds it and, for a same-site popup, its opener too.
import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import {
  getDesktopHost,
  type DesktopBrowserPageDialog,
  type DesktopBrowserPageDialogEvent,
} from "@/desktop/host";

const PAGE_DIALOG_EVENT = "browser-page-dialog";
const DIALOG_TYPES = new Set<DesktopBrowserPageDialog["type"]>(["alert", "confirm", "prompt"]);

export interface PageDialogEntry {
  /** The tab or popup that holds the dialog; answers go to it. */
  browserId: string;
  /** The tab whose pane shows it: the tab itself, or the tab a popup belongs to. */
  rootBrowserId: string;
  dialog: DesktopBrowserPageDialog;
}

interface PageDialogsState {
  dialogsByBrowserId: Record<string, PageDialogEntry>;
  apply: (event: DesktopBrowserPageDialogEvent) => void;
}

export function reducePageDialogs(
  current: Record<string, PageDialogEntry>,
  event: DesktopBrowserPageDialogEvent,
): Record<string, PageDialogEntry> {
  const existing = current[event.browserId];
  if (event.dialog) {
    const rootBrowserId = event.rootBrowserId ?? event.browserId;
    if (
      existing &&
      existing.dialog.id === event.dialog.id &&
      existing.rootBrowserId === rootBrowserId &&
      sameDialog(existing.dialog, event.dialog)
    ) {
      return current;
    }
    return {
      ...current,
      [event.browserId]: { browserId: event.browserId, rootBrowserId, dialog: event.dialog },
    };
  }
  if (!existing || (event.dialogId !== undefined && existing.dialog.id !== event.dialogId)) {
    return current;
  }
  const { [event.browserId]: _closed, ...rest } = current;
  return rest;
}

export const usePageDialogsStore = create<PageDialogsState>((set) => ({
  dialogsByBrowserId: {},
  apply: (event) =>
    set((state) => {
      const next = reducePageDialogs(state.dialogsByBrowserId, event);
      return next === state.dialogsByBrowserId ? state : { dialogsByBrowserId: next };
    }),
}));

export function readPageDialogEvent(payload: unknown): DesktopBrowserPageDialogEvent | null {
  if (!isRecord(payload) || typeof payload.browserId !== "string") return null;
  const dialogId = typeof payload.dialogId === "string" ? payload.dialogId : undefined;
  const rootBrowserId =
    typeof payload.rootBrowserId === "string" ? payload.rootBrowserId : undefined;
  const base = {
    browserId: payload.browserId,
    ...(rootBrowserId !== undefined ? { rootBrowserId } : {}),
  };
  if (payload.dialog === null) {
    return { ...base, dialog: null, ...(dialogId ? { dialogId } : {}) };
  }
  const dialog = readPageDialog(payload.dialog);
  return dialog ? { ...base, dialog } : null;
}

let watchState: "idle" | "starting" | "started" = "idle";

/**
 * Starts this window's page-dialog subscription once; panes call it when they mount. A failed
 * watch call leaves it idle, so the next pane mount tries again.
 */
export function ensurePageDialogWatch(): void {
  if (watchState !== "idle") return;
  const browser = getDesktopHost()?.browser;
  const events = getDesktopHost()?.events;
  if (!browser?.watchPageDialogs || !events?.on) return;
  watchState = "starting";
  void startPageDialogWatch(browser.watchPageDialogs, events.on);
}

async function startPageDialogWatch(
  watch: () => Promise<unknown[]>,
  on: (event: string, handler: (payload: unknown) => void) => Promise<() => void> | (() => void),
): Promise<void> {
  const apply = usePageDialogsStore.getState().apply;
  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = await on(PAGE_DIALOG_EVENT, (payload) => {
      const event = readPageDialogEvent(payload);
      if (event) apply(event);
    });
    for (const payload of await watch()) {
      const event = readPageDialogEvent(payload);
      if (event) apply(event);
    }
    watchState = "started";
  } catch (error) {
    console.error("[browser-dialogs] failed to watch page dialogs", error);
    unsubscribe?.();
    watchState = "idle";
  }
}

/** Where this window's subscription stands (tests). */
export function pageDialogWatchState(): typeof watchState {
  return watchState;
}

/** The page dialogs a tab and its popups hold open, for that tab's pane. */
export function useTabPageDialogs(rootBrowserId: string): PageDialogEntry[] {
  useEffect(() => {
    ensurePageDialogWatch();
  }, []);
  return usePageDialogsStore(
    useShallow((state) => selectTabPageDialogs(state.dialogsByBrowserId, rootBrowserId)),
  );
}

/** Whether the tab or one of its popups waits on a page dialog (the tab's needs-input mark). */
export function useTabHasPageDialog(rootBrowserId: string): boolean {
  useEffect(() => {
    ensurePageDialogWatch();
  }, []);
  return usePageDialogsStore(
    (state) => selectTabPageDialogs(state.dialogsByBrowserId, rootBrowserId).length > 0,
  );
}

export function selectTabPageDialogs(
  dialogsByBrowserId: Record<string, PageDialogEntry>,
  rootBrowserId: string,
): PageDialogEntry[] {
  return Object.values(dialogsByBrowserId).filter((entry) => entry.rootBrowserId === rootBrowserId);
}

/**
 * The one dialog a tab's pane shows. Several can be open at once (a cross-site popup runs in its
 * own process): the side on screen first, then the tab, then the popups in their strip order,
 * then the oldest.
 */
export function pickShownPageDialog(
  entries: readonly PageDialogEntry[],
  input: { rootBrowserId: string; shownBrowserId: string; popupOrder: readonly string[] },
): PageDialogEntry | null {
  let best: PageDialogEntry | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    const rank = shownPageDialogRank(entry, input);
    if (
      rank < bestRank ||
      (rank === bestRank && best !== null && entry.dialog.openedAt < best.dialog.openedAt)
    ) {
      best = entry;
      bestRank = rank;
    }
  }
  return best;
}

function shownPageDialogRank(
  entry: PageDialogEntry,
  input: { rootBrowserId: string; shownBrowserId: string; popupOrder: readonly string[] },
): number {
  if (entry.browserId === input.shownBrowserId) return 0;
  if (entry.browserId === input.rootBrowserId) return 1;
  const index = input.popupOrder.indexOf(entry.browserId);
  return index >= 0 ? 2 + index : 2 + input.popupOrder.length;
}

/**
 * Sends a person's answer. Resolves false when main no longer holds that dialog (already answered,
 * the page left, the tab is gone): the card is removed then, since its buttons can do nothing.
 */
export async function answerPageDialog(input: {
  browserId: string;
  dialogId: string;
  accept: boolean;
  promptText?: string;
  forNavigation?: boolean;
}): Promise<boolean> {
  const answer = getDesktopHost()?.browser?.answerPageDialog;
  let answered = false;
  if (answer) {
    try {
      answered = (await answer(input)) === true;
    } catch (error) {
      console.error("[browser-dialogs] failed to answer a page dialog", error);
    }
  }
  if (!answered) {
    usePageDialogsStore
      .getState()
      .apply({ browserId: input.browserId, dialog: null, dialogId: input.dialogId });
  }
  return answered;
}

function readPageDialog(value: unknown): DesktopBrowserPageDialog | null {
  if (!isRecord(value)) return null;
  const { id, type, message, openedAt, holder } = value;
  if (
    typeof id !== "string" ||
    typeof type !== "string" ||
    !DIALOG_TYPES.has(type as DesktopBrowserPageDialog["type"]) ||
    typeof message !== "string" ||
    typeof openedAt !== "number" ||
    (holder !== "agent" && holder !== "person")
  ) {
    return null;
  }
  return {
    id,
    type: type as DesktopBrowserPageDialog["type"],
    message,
    openedAt,
    holder,
    ...(typeof value.defaultValue === "string" ? { defaultValue: value.defaultValue } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
  };
}

function sameDialog(a: DesktopBrowserPageDialog, b: DesktopBrowserPageDialog): boolean {
  return a.holder === b.holder && a.expiresAt === b.expiresAt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
