/**
 * `/btw <question>` asks a side question; a bare `/btw` reopens the side thread.
 * Returns null for any other input, including `/btwx` or text that merely
 * mentions `/btw` later on.
 */
export function parseSideQuestionInput(text: string): { question: string } | null {
  const trimmed = text.trim();
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return { question: (match[1] ?? "").trim() };
}
