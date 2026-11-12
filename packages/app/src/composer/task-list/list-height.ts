const MIN_TASK_LIST_HEIGHT = 120;
// Daseo delta 95: the expanded task list scrolls inside this share of the height left above the
// keyboard. With the text area's own cap (45%, delta 59), the status lines and the prompt still
// fit below the header on the Fold 7 inner screen with the keyboard up.
const MAX_TASK_LIST_VIEWPORT_RATIO = 0.3;

export function resolveMaxTaskListHeight(windowHeight: number, keyboardHeight = 0): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return MIN_TASK_LIST_HEIGHT;
  const keyboard = Number.isFinite(keyboardHeight) && keyboardHeight > 0 ? keyboardHeight : 0;
  const available = Math.max(0, windowHeight - keyboard);
  return Math.max(MIN_TASK_LIST_HEIGHT, Math.floor(available * MAX_TASK_LIST_VIEWPORT_RATIO));
}
