import { describe, expect, it } from "vitest";
import { removeSubmittedFromDraft, restoreFailedIntoDraft } from "./draft-snapshot";

describe("draft snapshot helpers", () => {
  it("removes exactly the submitted text and attachments", () => {
    expect(
      removeSubmittedFromDraft(
        { text: "  queued text more", attachments: [{ id: "a" }, { id: "b" }] },
        { text: "queued text", attachments: [{ id: "a" }] },
      ),
    ).toEqual({ text: "more", attachments: [{ id: "b" }] });
  });

  it("leaves a draft alone when the submitted text was edited", () => {
    expect(
      removeSubmittedFromDraft(
        { text: "queued txt", attachments: [] },
        { text: "queued text", attachments: [] },
      ),
    ).toBeNull();
  });

  it("puts a failed message in front of newer input without dropping either", () => {
    expect(
      restoreFailedIntoDraft(
        { text: "newer", attachments: [{ id: "n" }] },
        { text: "failed", attachments: [{ id: "f" }] },
      ),
    ).toEqual({ text: "failed\n\nnewer", attachments: [{ id: "f" }, { id: "n" }] });
  });
});
