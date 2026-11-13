// Daseo delta 102: a passkey sign-in the person started on a site with two or more stored accounts
// waits for the person to pick one, inside that tab's own pane. Main owns every waiting request
// (packages/desktop/src/features/browser-automation/passkeys.ts); this window says once that its
// panes can show them, then keeps one entry per browser id from the `browser-passkey-choice` event.
import { useEffect } from "react";
import { create } from "zustand";
import {
  getDesktopHost,
  type DesktopBrowserPasskeyChoice,
  type DesktopBrowserPasskeyChoiceEvent,
} from "@/desktop/host";

const PASSKEY_CHOICE_EVENT = "browser-passkey-choice";

interface PasskeyChoicesState {
  choicesByBrowserId: Record<string, DesktopBrowserPasskeyChoice>;
  apply: (event: DesktopBrowserPasskeyChoiceEvent) => void;
}

export function reducePasskeyChoices(
  current: Record<string, DesktopBrowserPasskeyChoice>,
  event: DesktopBrowserPasskeyChoiceEvent,
): Record<string, DesktopBrowserPasskeyChoice> {
  const existing = current[event.browserId];
  if (event.choice) {
    if (existing && existing.id === event.choice.id) return current;
    return { ...current, [event.browserId]: event.choice };
  }
  if (!existing || (event.choiceId !== undefined && existing.id !== event.choiceId)) {
    return current;
  }
  const { [event.browserId]: _closed, ...rest } = current;
  return rest;
}

export const usePasskeyChoicesStore = create<PasskeyChoicesState>((set) => ({
  choicesByBrowserId: {},
  apply: (event) =>
    set((state) => {
      const next = reducePasskeyChoices(state.choicesByBrowserId, event);
      return next === state.choicesByBrowserId ? state : { choicesByBrowserId: next };
    }),
}));

export function readPasskeyChoiceEvent(payload: unknown): DesktopBrowserPasskeyChoiceEvent | null {
  if (!isRecord(payload) || typeof payload.browserId !== "string") return null;
  const choiceId = typeof payload.choiceId === "string" ? payload.choiceId : undefined;
  if (payload.choice === null) {
    return { browserId: payload.browserId, choice: null, ...(choiceId ? { choiceId } : {}) };
  }
  const choice = readPasskeyChoice(payload.choice);
  return choice ? { browserId: payload.browserId, choice } : null;
}

let watchStarted = false;

/** Starts this window's passkey-choice subscription once; panes call it when they mount. */
function ensurePasskeyChoiceWatch(): void {
  if (watchStarted) return;
  const browser = getDesktopHost()?.browser;
  const events = getDesktopHost()?.events;
  if (!browser?.watchPasskeyChoices || !events?.on) return;
  watchStarted = true;
  const apply = usePasskeyChoicesStore.getState().apply;
  void events.on(PASSKEY_CHOICE_EVENT, (payload) => {
    const event = readPasskeyChoiceEvent(payload);
    if (event) apply(event);
  });
  void loadOpenPasskeyChoices(browser.watchPasskeyChoices, apply);
}

async function loadOpenPasskeyChoices(
  watch: () => Promise<unknown[]>,
  apply: (event: DesktopBrowserPasskeyChoiceEvent) => void,
): Promise<void> {
  try {
    for (const payload of await watch()) {
      const event = readPasskeyChoiceEvent(payload);
      if (event) apply(event);
    }
  } catch (error) {
    console.error("[browser-passkeys] failed to watch passkey choices", error);
  }
}

/** The account choice the tab or popup `browserId` waits on, or null. */
export function usePasskeyChoice(browserId: string | null): DesktopBrowserPasskeyChoice | null {
  useEffect(() => {
    ensurePasskeyChoiceWatch();
  }, []);
  return usePasskeyChoicesStore((state) =>
    browserId ? (state.choicesByBrowserId[browserId] ?? null) : null,
  );
}

export function answerPasskeyChoice(input: {
  browserId: string;
  choiceId: string;
  credentialId: string | null;
}): void {
  void getDesktopHost()
    ?.browser?.answerPasskeyChoice?.(input)
    .catch((error) => {
      console.error("[browser-passkeys] failed to answer a passkey choice", error);
    });
}

function readPasskeyChoice(value: unknown): DesktopBrowserPasskeyChoice | null {
  if (!isRecord(value)) return null;
  const { id, rpId, accounts, since } = value;
  if (
    typeof id !== "string" ||
    typeof rpId !== "string" ||
    typeof since !== "number" ||
    !Array.isArray(accounts)
  ) {
    return null;
  }
  const parsed: DesktopBrowserPasskeyChoice["accounts"] = [];
  for (const account of accounts) {
    if (!isRecord(account) || typeof account.credentialId !== "string") return null;
    parsed.push({
      credentialId: account.credentialId,
      ...(typeof account.userName === "string" ? { userName: account.userName } : {}),
      ...(typeof account.userDisplayName === "string"
        ? { userDisplayName: account.userDisplayName }
        : {}),
    });
  }
  if (parsed.length === 0) return null;
  return {
    id,
    rpId,
    accounts: parsed,
    since,
    ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
