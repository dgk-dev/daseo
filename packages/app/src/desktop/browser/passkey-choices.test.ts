import { describe, expect, it } from "vitest";
import type { DesktopBrowserPasskeyChoice } from "@/desktop/host";
import { readPasskeyChoiceEvent, reducePasskeyChoices } from "./passkey-choices";
import { passkeyAccountLabel } from "./pane/passkey-choice-card.electron";

const choice: DesktopBrowserPasskeyChoice = {
  id: "passkey-request-1",
  rpId: "github.com",
  accounts: [
    { credentialId: "AAAA", userName: "ax-dfcorp" },
    { credentialId: "BBBB", userName: "dgk-dev", userDisplayName: "David" },
  ],
  since: 1,
  expiresAt: 60_001,
};

describe("passkey account choices in panes (delta 102)", () => {
  it("keeps one choice per tab and drops it only for the choice that went away", () => {
    const shown = reducePasskeyChoices({}, { browserId: "tab-a", choice });
    expect(shown).toEqual({ "tab-a": choice });
    expect(reducePasskeyChoices(shown, { browserId: "tab-a", choice: { ...choice } })).toBe(shown);
    expect(
      reducePasskeyChoices(shown, {
        browserId: "tab-a",
        choice: null,
        choiceId: "passkey-request-0",
      }),
    ).toBe(shown);
    expect(reducePasskeyChoices(shown, { browserId: "tab-b", choice: null })).toBe(shown);
    expect(
      reducePasskeyChoices(shown, { browserId: "tab-a", choice: null, choiceId: choice.id }),
    ).toEqual({});
  });

  it("reads only well-formed events from main", () => {
    expect(readPasskeyChoiceEvent({ browserId: "tab-a", choice })).toEqual({
      browserId: "tab-a",
      choice,
    });
    expect(readPasskeyChoiceEvent({ browserId: "tab-a", choice: null, choiceId: "x" })).toEqual({
      browserId: "tab-a",
      choice: null,
      choiceId: "x",
    });
    expect(
      readPasskeyChoiceEvent({ browserId: "tab-a", choice: { ...choice, accounts: [] } }),
    ).toBeNull();
    expect(
      readPasskeyChoiceEvent({ browserId: "tab-a", choice: { ...choice, accounts: [{}] } }),
    ).toBeNull();
    expect(readPasskeyChoiceEvent({ choice })).toBeNull();
  });

  it("labels an account by display name and user name", () => {
    expect(passkeyAccountLabel(choice.accounts[0])).toBe("ax-dfcorp");
    expect(passkeyAccountLabel(choice.accounts[1])).toBe("David (dgk-dev)");
    expect(passkeyAccountLabel({ credentialId: "CCCCCCCCCCCCCCCC" })).toBe("CCCCCCCCCCCC");
  });
});
