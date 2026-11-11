import { describe, expect, it } from "vitest";
import type { DesktopBrowserPageDialog } from "@/desktop/host";
import { readPageDialogEvent, reducePageDialogs } from "./page-dialogs";

const confirm: DesktopBrowserPageDialog = {
  id: "dialog-1",
  type: "confirm",
  message: "Save?",
  openedAt: 1,
  holder: "person",
};

describe("page dialogs in panes (delta 93)", () => {
  it("keeps one dialog per tab and drops it only for the dialog that closed", () => {
    const shown = reducePageDialogs({}, { browserId: "tab-a", dialog: confirm });
    expect(shown).toEqual({ "tab-a": confirm });

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
      "tab-a": claimed,
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
      readPageDialogEvent({ browserId: "tab-a", dialog: { ...confirm, type: "file" } }),
    ).toBeNull();
    expect(readPageDialogEvent({ dialog: confirm })).toBeNull();
    expect(readPageDialogEvent(null)).toBeNull();
  });
});
