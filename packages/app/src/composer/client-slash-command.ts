import { isDraftSnapshotEmpty, type DraftSnapshot } from "@/composer/draft-snapshot";

/**
 * Runs an immediate client slash command. The input clears at once so the command feels
 * instant; when the command fails its text goes back, unless the user has typed since.
 */
export async function runImmediateClientSlashCommand<TAttachment>(input: {
  commandText: string;
  execute: () => Promise<void>;
  clearInput: () => void;
  readCurrentDraft: () => DraftSnapshot<TAttachment>;
  restoreText: (text: string) => void;
  setSendError: (message: string | null) => void;
  setIsProcessing: (isProcessing: boolean) => void;
}): Promise<"done" | "failed"> {
  input.clearInput();
  input.setSendError(null);
  input.setIsProcessing(true);
  try {
    await input.execute();
    return "done";
  } catch (error) {
    console.error("[Composer] Failed to run client slash command:", error);
    if (isDraftSnapshotEmpty(input.readCurrentDraft())) {
      input.restoreText(input.commandText);
    }
    input.setSendError(error instanceof Error ? error.message : String(error));
    return "failed";
  } finally {
    input.setIsProcessing(false);
  }
}
