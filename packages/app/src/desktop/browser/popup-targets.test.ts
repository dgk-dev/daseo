import { describe, expect, test } from "vitest";
import {
  readBrowserPopupTargetsSnapshot,
  reduceBrowserPopupTargetState,
  selectAvailablePopupTarget,
} from "./popup-targets";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const POPUP_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_POPUP_ID = "33333333-3333-4333-8333-333333333333";

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 1,
    rootBrowserId: ROOT_ID,
    workspaceId: "workspace-a",
    hostWebContentsId: 10,
    reason: "created",
    targets: [
      {
        browserId: POPUP_ID,
        rootBrowserId: ROOT_ID,
        openerBrowserId: ROOT_ID,
        workspaceId: "workspace-a",
        url: "https://login.example.com",
        title: "Sign in",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        isVisible: false,
        disposition: "new-window",
        createdAt: 1_000,
      },
    ],
    ...overrides,
  };
}

describe("browser popup target snapshots", () => {
  test("accepts a complete workspace-owned popup snapshot", () => {
    expect(
      readBrowserPopupTargetsSnapshot(
        snapshot({ activationBrowserId: POPUP_ID, focusedBrowserId: POPUP_ID }),
      ),
    ).toEqual({
      revision: 1,
      rootBrowserId: ROOT_ID,
      workspaceId: "workspace-a",
      hostWebContentsId: 10,
      reason: "created",
      activationBrowserId: POPUP_ID,
      focusedBrowserId: POPUP_ID,
      targets: [
        {
          browserId: POPUP_ID,
          rootBrowserId: ROOT_ID,
          openerBrowserId: ROOT_ID,
          workspaceId: "workspace-a",
          url: "https://login.example.com",
          title: "Sign in",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          isVisible: false,
          disposition: "new-window",
          createdAt: 1_000,
        },
      ],
    });
  });

  test.each([
    ["invalid root id", { rootBrowserId: "default" }],
    ["invalid revision", { revision: -1 }],
    ["invalid host", { hostWebContentsId: 0 }],
    ["unknown reason", { reason: "opened" }],
    ["unknown disposition", { targets: [{ disposition: "popup" }] }],
  ])("rejects %s", (_name, overrides) => {
    expect(readBrowserPopupTargetsSnapshot(snapshot(overrides))).toBeNull();
  });

  test("rejects a popup that claims another workspace or root", () => {
    const otherWorkspace = snapshot();
    otherWorkspace.targets = [
      {
        ...(otherWorkspace.targets as Array<Record<string, unknown>>)[0],
        workspaceId: "workspace-b",
      },
    ];
    const otherRoot = snapshot();
    otherRoot.targets = [
      {
        ...(otherRoot.targets as Array<Record<string, unknown>>)[0],
        rootBrowserId: SECOND_POPUP_ID,
      },
    ];

    expect(readBrowserPopupTargetsSnapshot(otherWorkspace)).toBeNull();
    expect(readBrowserPopupTargetsSnapshot(otherRoot)).toBeNull();
  });

  test("rejects duplicate target ids and activation references outside the snapshot", () => {
    const duplicate = snapshot();
    duplicate.targets = [
      ...(duplicate.targets as unknown[]),
      { ...(duplicate.targets as Array<Record<string, unknown>>)[0] },
    ];

    expect(readBrowserPopupTargetsSnapshot(duplicate)).toBeNull();
    expect(
      readBrowserPopupTargetsSnapshot(snapshot({ activationBrowserId: SECOND_POPUP_ID })),
    ).toBeNull();
  });

  test("revision ordering prevents a late initial list from overwriting a live event", () => {
    const initial = { rootBrowserId: ROOT_ID, snapshot: null };
    const live = reduceBrowserPopupTargetState(initial, snapshot({ revision: 3 }));
    const staleList = reduceBrowserPopupTargetState(
      live,
      snapshot({ revision: 2, reason: "updated" }),
    );
    const duplicate = reduceBrowserPopupTargetState(
      live,
      snapshot({ revision: 3, reason: "updated" }),
    );

    expect(staleList).toBe(live);
    expect(duplicate).toBe(live);
  });

  test("ignores events for another root browser", () => {
    const initial = { rootBrowserId: ROOT_ID, snapshot: null };

    expect(
      reduceBrowserPopupTargetState(
        initial,
        snapshot({ rootBrowserId: SECOND_POPUP_ID, targets: [] }),
      ),
    ).toBe(initial);
  });

  test("keeps the selected target only while it remains live", () => {
    const targets = readBrowserPopupTargetsSnapshot(snapshot())?.targets ?? [];

    expect(selectAvailablePopupTarget({ selectedBrowserId: POPUP_ID, targets })).toBe(POPUP_ID);
    expect(selectAvailablePopupTarget({ selectedBrowserId: SECOND_POPUP_ID, targets })).toBeNull();
    expect(selectAvailablePopupTarget({ selectedBrowserId: null, targets })).toBeNull();
  });
});
