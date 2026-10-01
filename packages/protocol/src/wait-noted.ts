/**
 * Daseo: the reply pi-local's `wait_for` wake footer asks for when a wake needs nothing
 * from the agent. A wake can land after the agent's final answer (the Claude bridge only
 * injects it while a tool call is pending), and the woken turn used to end on a line like
 * "No response requested." that replaced the real report as the last message, in push
 * notifications, and in a parent's finished notice. The app hides this reply and the
 * daemon skips it when it picks the last assistant message.
 */
export const WAIT_NOTED_REPLY = "[wait noted]";

// Models sometimes wrap the token in backticks or end it with a period.
const WAIT_NOTED_PATTERN = /^`?\[wait noted\]`?\.?$/i;

export function isWaitNotedReply(text: string): boolean {
  return WAIT_NOTED_PATTERN.test(text.trim());
}

/**
 * The text of the last contiguous run of assistant messages, skipping runs that are only the
 * wait-noted reply. `items` is read newest-first through `at`; non-assistant items separate runs.
 */
export function lastAssistantRun<T>(
  length: number,
  at: (index: number) => T | undefined,
  assistantText: (item: T) => string | null,
): { text: string; startIndex: number } | null {
  let chunks: string[] = [];
  let startIndex = -1;
  for (let index = length - 1; index >= 0; index -= 1) {
    const item = at(index);
    const text = item === undefined ? null : assistantText(item);
    if (text === null) {
      if (chunks.length === 0) continue;
      const joined = chunks.toReversed().join("");
      if (!isWaitNotedReply(joined)) return { text: joined, startIndex };
      chunks = [];
      continue;
    }
    chunks.push(text);
    startIndex = index;
  }
  if (chunks.length === 0) return null;
  const joined = chunks.toReversed().join("");
  return isWaitNotedReply(joined) ? null : { text: joined, startIndex };
}
