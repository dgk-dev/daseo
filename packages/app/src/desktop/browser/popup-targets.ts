import { useEffect, useState } from "react";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  getDesktopHost,
  type DesktopBrowserPopupTarget,
  type DesktopBrowserPopupTargetsSnapshot,
} from "@/desktop/host";

const POPUP_TARGETS_EVENT = "browser-popup-targets";
const POPUP_DISPOSITIONS = new Set<DesktopBrowserPopupTarget["disposition"]>([
  "default",
  "foreground-tab",
  "background-tab",
  "new-window",
  "other",
]);
const POPUP_REASONS = new Set<DesktopBrowserPopupTargetsSnapshot["reason"]>([
  "bound",
  "created",
  "updated",
  "focused",
  "presentation",
  "closed",
]);

export interface BrowserPopupTargetState {
  rootBrowserId: string;
  snapshot: DesktopBrowserPopupTargetsSnapshot | null;
}

interface PopupSnapshotEnvelope {
  payload: Record<string, unknown>;
  revision: number;
  rootBrowserId: string;
  workspaceId: string;
  hostWebContentsId: number;
  reason: DesktopBrowserPopupTargetsSnapshot["reason"];
  rawTargets: unknown[];
}

export function readBrowserPopupTargetsSnapshot(
  payload: unknown,
): DesktopBrowserPopupTargetsSnapshot | null {
  const envelope = readPopupSnapshotEnvelope(payload);
  if (!envelope) {
    return null;
  }
  const {
    payload: record,
    revision,
    rootBrowserId,
    workspaceId,
    hostWebContentsId,
    reason,
    rawTargets,
  } = envelope;
  const targets: DesktopBrowserPopupTarget[] = [];
  for (const candidate of rawTargets) {
    const target = readPopupTarget(candidate);
    if (!target || target.rootBrowserId !== rootBrowserId || target.workspaceId !== workspaceId) {
      return null;
    }
    targets.push(target);
  }
  const uniqueIds = new Set(targets.map((target) => target.browserId));
  if (uniqueIds.size !== targets.length) {
    return null;
  }

  const activationBrowserId = readOptionalBrowserId(record.activationBrowserId);
  const focusedBrowserId = readOptionalBrowserId(record.focusedBrowserId);
  if (
    (activationBrowserId && !uniqueIds.has(activationBrowserId)) ||
    (focusedBrowserId && !uniqueIds.has(focusedBrowserId))
  ) {
    return null;
  }

  return {
    revision,
    rootBrowserId,
    workspaceId,
    hostWebContentsId,
    reason,
    targets,
    ...(activationBrowserId ? { activationBrowserId } : {}),
    ...(focusedBrowserId ? { focusedBrowserId } : {}),
  };
}

export function reduceBrowserPopupTargetState(
  current: BrowserPopupTargetState,
  payload: unknown,
): BrowserPopupTargetState {
  const snapshot = readBrowserPopupTargetsSnapshot(payload);
  if (!snapshot || snapshot.rootBrowserId !== current.rootBrowserId) {
    return current;
  }
  if (current.snapshot && snapshot.revision <= current.snapshot.revision) {
    return current;
  }
  return { rootBrowserId: current.rootBrowserId, snapshot };
}

export function selectAvailablePopupTarget(input: {
  selectedBrowserId: string | null;
  targets: readonly DesktopBrowserPopupTarget[];
}): string | null {
  if (
    input.selectedBrowserId &&
    input.targets.some((target) => target.browserId === input.selectedBrowserId)
  ) {
    return input.selectedBrowserId;
  }
  return null;
}

export function useDesktopBrowserPopupTargets(rootBrowserId: string): BrowserPopupTargetState {
  const [state, setState] = useState<BrowserPopupTargetState>({
    rootBrowserId,
    snapshot: null,
  });

  useEffect(() => {
    let disposed = false;
    setState({ rootBrowserId, snapshot: null });
    const handleSnapshot = (payload: unknown) => {
      if (!disposed) {
        setState((current) =>
          current.rootBrowserId === rootBrowserId
            ? reduceBrowserPopupTargetState(current, payload)
            : current,
        );
      }
    };
    const host = getDesktopHost();
    const unsubscribe = host?.events?.on?.(POPUP_TARGETS_EVENT, handleSnapshot);
    void host?.browser
      ?.listPopupTargets?.(rootBrowserId)
      .then(handleSnapshot)
      .catch((error) => {
        console.error("[browser-popup] failed to list popup targets", error);
      });

    return () => {
      disposed = true;
      if (typeof unsubscribe === "function") {
        unsubscribe();
      } else {
        void unsubscribe?.then((dispose) => dispose());
      }
    };
  }, [rootBrowserId]);

  return state.rootBrowserId === rootBrowserId ? state : { rootBrowserId, snapshot: null };
}

function readPopupSnapshotEnvelope(payload: unknown): PopupSnapshotEnvelope | null {
  if (!isRecord(payload)) return null;
  const rootBrowserId = readBrowserId(payload.rootBrowserId);
  const workspaceId = readNonEmptyString(payload.workspaceId);
  const reason = readPopupReason(payload.reason);
  if (
    !isNonNegativeSafeInteger(payload.revision) ||
    !rootBrowserId ||
    !workspaceId ||
    !isPositiveSafeInteger(payload.hostWebContentsId) ||
    !reason ||
    !Array.isArray(payload.targets)
  ) {
    return null;
  }
  return {
    payload,
    revision: payload.revision,
    rootBrowserId,
    workspaceId,
    hostWebContentsId: payload.hostWebContentsId,
    reason,
    rawTargets: payload.targets,
  };
}

function readPopupReason(value: unknown): DesktopBrowserPopupTargetsSnapshot["reason"] | null {
  return typeof value === "string" &&
    POPUP_REASONS.has(value as DesktopBrowserPopupTargetsSnapshot["reason"])
    ? (value as DesktopBrowserPopupTargetsSnapshot["reason"])
    : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readPopupTarget(payload: unknown): DesktopBrowserPopupTarget | null {
  if (!isRecord(payload)) {
    return null;
  }
  const browserId = readBrowserId(payload.browserId);
  const rootBrowserId = readBrowserId(payload.rootBrowserId);
  const openerBrowserId = readBrowserId(payload.openerBrowserId);
  const workspaceId = readNonEmptyString(payload.workspaceId);
  const disposition = payload.disposition;
  const createdAt = payload.createdAt;
  if (
    !browserId ||
    !rootBrowserId ||
    !openerBrowserId ||
    !workspaceId ||
    typeof payload.url !== "string" ||
    typeof payload.title !== "string" ||
    typeof payload.isLoading !== "boolean" ||
    typeof payload.canGoBack !== "boolean" ||
    typeof payload.canGoForward !== "boolean" ||
    typeof payload.isVisible !== "boolean" ||
    typeof disposition !== "string" ||
    !POPUP_DISPOSITIONS.has(disposition as DesktopBrowserPopupTarget["disposition"]) ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt)
  ) {
    return null;
  }
  return {
    browserId,
    rootBrowserId,
    openerBrowserId,
    workspaceId,
    url: payload.url,
    title: payload.title,
    isLoading: payload.isLoading,
    canGoBack: payload.canGoBack,
    canGoForward: payload.canGoForward,
    isVisible: payload.isVisible,
    disposition: disposition as DesktopBrowserPopupTarget["disposition"],
    createdAt,
  };
}

function readBrowserId(value: unknown): string | null {
  const parsed = BrowserAutomationBrowserIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readOptionalBrowserId(value: unknown): string | null {
  return value === undefined ? null : readBrowserId(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
