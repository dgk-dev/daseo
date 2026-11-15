import { describe, expect, it, vi } from "vitest";
import { runImmediateClientSlashCommand } from "./client-slash-command";

function createInput(execute: () => Promise<void>) {
  const draft = { text: "/archive", attachments: [] as string[] };
  const setSendError = vi.fn();
  return {
    draft,
    setSendError,
    params: {
      commandText: "/archive",
      execute,
      clearInput: () => {
        draft.text = "";
      },
      readCurrentDraft: () => ({ text: draft.text, attachments: draft.attachments }),
      restoreText: (text: string) => {
        draft.text = text;
      },
      setSendError,
      setIsProcessing: vi.fn(),
    },
  };
}

describe("runImmediateClientSlashCommand", () => {
  it("puts the command text back when the command fails", async () => {
    const input = createInput(async () => {
      throw new Error("Agent is busy");
    });

    await expect(runImmediateClientSlashCommand(input.params)).resolves.toBe("failed");

    expect(input.draft.text).toBe("/archive");
    expect(input.setSendError).toHaveBeenLastCalledWith("Agent is busy");
  });

  it("does not overwrite text typed while the failed command ran", async () => {
    let fail!: (error: Error) => void;
    const input = createInput(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );

    const running = runImmediateClientSlashCommand(input.params);
    expect(input.draft.text).toBe("");
    input.draft.text = "something new";
    fail(new Error("nope"));
    await running;

    expect(input.draft.text).toBe("something new");
  });

  it("leaves the input empty when the command succeeds", async () => {
    const input = createInput(async () => undefined);
    await expect(runImmediateClientSlashCommand(input.params)).resolves.toBe("done");
    expect(input.draft.text).toBe("");
  });
});
