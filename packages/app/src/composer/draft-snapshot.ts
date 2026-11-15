/**
 * The composer stays editable while a send or queue write is in flight. These helpers decide
 * what to do with whatever the user typed in the meantime, so finishing an earlier submission
 * never erases or overwrites newer input.
 */
export interface DraftSnapshot<TAttachment> {
  text: string;
  attachments: readonly TAttachment[];
}

export function isDraftSnapshotEmpty<TAttachment>(draft: DraftSnapshot<TAttachment>): boolean {
  return draft.text.trim().length === 0 && draft.attachments.length === 0;
}

function attachmentKey(attachment: unknown): string {
  return JSON.stringify(attachment);
}

/**
 * Removes a submitted message from the draft that still shows it. Returns the input typed
 * after it, or `null` when the submitted text is no longer at the start of the draft (the user
 * edited it), in which case the draft must be left alone.
 */
export function removeSubmittedFromDraft<TAttachment>(
  current: DraftSnapshot<TAttachment>,
  submitted: DraftSnapshot<TAttachment>,
): DraftSnapshot<TAttachment> | null {
  const submittedText = submitted.text.trim();
  let remainingText: string;
  if (submittedText.length === 0) {
    remainingText = current.text;
  } else {
    const index = current.text.indexOf(submittedText);
    if (index < 0 || current.text.slice(0, index).trim().length > 0) return null;
    remainingText = current.text.slice(index + submittedText.length);
  }
  const submittedKeys = new Map<string, number>();
  for (const attachment of submitted.attachments) {
    const key = attachmentKey(attachment);
    submittedKeys.set(key, (submittedKeys.get(key) ?? 0) + 1);
  }
  const remainingAttachments = current.attachments.filter((attachment) => {
    const key = attachmentKey(attachment);
    const count = submittedKeys.get(key) ?? 0;
    if (count === 0) return true;
    submittedKeys.set(key, count - 1);
    return false;
  });
  return {
    text: remainingText.trim().length === 0 ? "" : remainingText.replace(/^\s+/, ""),
    attachments: remainingAttachments,
  };
}

/** Puts a failed message back in front of the newer draft, without dropping either. */
export function restoreFailedIntoDraft<TAttachment>(
  current: DraftSnapshot<TAttachment>,
  failed: DraftSnapshot<TAttachment>,
): DraftSnapshot<TAttachment> {
  const currentText = current.text.trim();
  return {
    text: currentText.length === 0 ? failed.text : `${failed.text}\n\n${current.text}`,
    attachments: [...failed.attachments, ...current.attachments],
  };
}
