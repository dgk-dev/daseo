// Daseo delta 93: page dialogs (alert, confirm, prompt) a browser tab holds open, shown inside that
// tab's own pane. Main owns every dialog (packages/desktop/src/features/browser-automation/
// page-dialogs.ts); this window says once that its panes can show them, then keeps one entry per
// browser id from the `browser-page-dialog` event.
import { useEffect } from "react";
import { create } from "zustand";
import {
  getDesktopHost,
  type DesktopBrowserPageDialog,
  type DesktopBrowserPageDialogEvent,
} from "@/desktop/host";

const PAGE_DIALOG_EVENT = "browser-page-dialog";
const DIALOG_TYPES = new Set<DesktopBrowserPageDialog["type"]>(["alert", "confirm", "prompt"]);

interface PageDialogsState {
  dialogsByBrowserId: Record<string, DesktopBrowserPageDialog>;
  apply: (event: DesktopBrowserPageDialogEvent) => void;
}

export function reducePageDialogs(
  current: Record<string, DesktopBrowserPageDialog>,
  event: DesktopBrowserPageDialogEvent,
): Record<string, DesktopBrowserPageDialog> {
  const existing = current[event.browserId];
  if (event.dialog) {
    if (existing && existing.id === event.dialog.id && sameDialog(existing, event.dialog)) {
      return current;
    }
    return { ...current, [event.browserId]: event.dialog };
  }
  if (!existing || (event.dialogId !== undefined && existing.id !== event.dialogId)) {
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
  if (payload.dialog === null) {
    return { browserId: payload.browserId, dialog: null, ...(dialogId ? { dialogId } : {}) };
  }
  const dialog = readPageDialog(payload.dialog);
  return dialog ? { browserId: payload.browserId, dialog } : null;
}

let watchStarted = false;

/** Starts this window's page-dialog subscription once; panes call it when they mount. */
function ensurePageDialogWatch(): void {
  if (watchStarted) return;
  const browser = getDesktopHost()?.browser;
  const events = getDesktopHost()?.events;
  if (!browser?.watchPageDialogs || !events?.on) return;
  watchStarted = true;
  const apply = usePageDialogsStore.getState().apply;
  void events.on(PAGE_DIALOG_EVENT, (payload) => {
    const event = readPageDialogEvent(payload);
    if (event) apply(event);
  });
  void loadOpenPageDialogs(browser.watchPageDialogs, apply);
}

async function loadOpenPageDialogs(
  watch: () => Promise<unknown[]>,
  apply: (event: DesktopBrowserPageDialogEvent) => void,
): Promise<void> {
  try {
    for (const payload of await watch()) {
      const event = readPageDialogEvent(payload);
      if (event) apply(event);
    }
  } catch (error) {
    console.error("[browser-dialogs] failed to watch page dialogs", error);
  }
}

/** The dialog the tab or popup `browserId` holds open, or null. */
export function usePageDialog(browserId: string | null): DesktopBrowserPageDialog | null {
  useEffect(() => {
    ensurePageDialogWatch();
  }, []);
  return usePageDialogsStore((state) =>
    browserId ? (state.dialogsByBrowserId[browserId] ?? null) : null,
  );
}

export function answerPageDialog(input: {
  browserId: string;
  dialogId: string;
  accept: boolean;
  promptText?: string;
}): void {
  void getDesktopHost()
    ?.browser?.answerPageDialog?.(input)
    .catch((error) => {
      console.error("[browser-dialogs] failed to answer a page dialog", error);
    });
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
