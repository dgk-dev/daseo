// Daseo delta 102. A passkey request that a person started (a click on the site's passkey button)
// on a site with two or more stored accounts waits for the person to pick one. The pick happens in
// the tab's own pane, like a delta 93 page dialog: main sends the waiting request to the host window
// that shows the tab, and the pane answers it back. No macOS window or sheet.

import {
  getPaseoBrowserPasskeys,
  setPaseoBrowserPasskeyChoiceSurface,
  type WaitingPasskeyRequest,
} from "./passkeys.js";

/** Main to host renderer: a tab's account choice appeared (`choice`) or went away (`null`). */
export const PASSKEY_CHOICE_SURFACE_EVENT = "paseo:event:browser-passkey-choice";

export interface PasskeyChoiceSurfaceChoice {
  id: string;
  rpId: string;
  accounts: Array<{ credentialId: string; userName?: string; userDisplayName?: string }>;
  since: number;
  expiresAt?: number;
}

export interface PasskeyChoiceSurfacePayload {
  browserId: string;
  choice: PasskeyChoiceSurfaceChoice | null;
  /** With `choice: null`: the choice that went away. */
  choiceId?: string;
}

export interface PasskeyChoiceSurfacePorts {
  /** The browser id and host window of a registered tab or popup; null when not registered. */
  locate(contentsId: number): { browserId: string; hostWebContentsId: number } | null;
  send(hostWebContentsId: number, payload: PasskeyChoiceSurfacePayload): void;
}

const watchingHostIds = new Set<number>();

export function installPaseoBrowserPasskeyChoiceSurface(ports: PasskeyChoiceSurfacePorts): void {
  const deliver = (
    contentsId: number,
    payload: (browserId: string) => PasskeyChoiceSurfacePayload,
  ) => {
    const location = ports.locate(contentsId);
    if (location && watchingHostIds.has(location.hostWebContentsId)) {
      ports.send(location.hostWebContentsId, payload(location.browserId));
    }
  };
  setPaseoBrowserPasskeyChoiceSurface({
    show: (request) =>
      deliver(request.contentsId, (browserId) => ({ browserId, choice: toSurfaceChoice(request) })),
    hide: (contentsId, requestId) =>
      deliver(contentsId, (browserId) => ({ browserId, choice: null, choiceId: requestId })),
  });
  locatePorts = ports;
}

let locatePorts: PasskeyChoiceSurfacePorts | null = null;

/** A host window's panes can show account choices; returns the ones its tabs hold right now. */
export function watchPaseoBrowserPasskeyChoices(
  hostWebContentsId: number,
): PasskeyChoiceSurfacePayload[] {
  watchingHostIds.add(hostWebContentsId);
  const open: PasskeyChoiceSurfacePayload[] = [];
  for (const request of getPaseoBrowserPasskeys()?.waitingChoices() ?? []) {
    const location = locatePorts?.locate(request.contentsId);
    if (location?.hostWebContentsId === hostWebContentsId) {
      open.push({ browserId: location.browserId, choice: toSurfaceChoice(request) });
    }
  }
  return open;
}

export function unwatchPaseoBrowserPasskeyChoices(hostWebContentsId: number): void {
  watchingHostIds.delete(hostWebContentsId);
}

export function readPasskeyChoiceAnswer(
  input: unknown,
): { browserId: string; choiceId: string; credentialId: string | null } | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (typeof record.browserId !== "string" || typeof record.choiceId !== "string") return null;
  if (record.credentialId !== null && typeof record.credentialId !== "string") return null;
  return {
    browserId: record.browserId,
    choiceId: record.choiceId,
    credentialId: record.credentialId,
  };
}

function toSurfaceChoice(request: WaitingPasskeyRequest): PasskeyChoiceSurfaceChoice {
  return {
    id: request.id,
    rpId: request.rpId,
    accounts: request.accounts.map((account) => ({
      credentialId: account.credentialId,
      ...(account.userName ? { userName: account.userName } : {}),
      ...(account.userDisplayName ? { userDisplayName: account.userDisplayName } : {}),
    })),
    since: request.since,
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
  };
}
