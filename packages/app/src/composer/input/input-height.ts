const DEFAULT_MAX_INPUT_HEIGHT = 160;
// Daseo delta 59: the share of the height left above the keyboard. The composer also carries
// status lines, attachments, and padding above the text, so half of that space would still
// reach the header on the Fold 7 inner screen (712 dp tall, keyboard about 280 dp).
const MAX_INPUT_VIEWPORT_RATIO = 0.45;

/**
 * The tallest the text area may grow. `keyboardHeight` is the on-screen keyboard (0 when
 * hidden, and always 0 on web); subtracting it keeps a long draft below the header while
 * typing, because the window itself is not resized for the keyboard on Android edge-to-edge.
 */
export function resolveMaxInputHeight(windowHeight: number, keyboardHeight = 0): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return DEFAULT_MAX_INPUT_HEIGHT;
  const keyboard = Number.isFinite(keyboardHeight) && keyboardHeight > 0 ? keyboardHeight : 0;
  const available = Math.max(0, windowHeight - keyboard);
  return Math.max(DEFAULT_MAX_INPUT_HEIGHT, Math.floor(available * MAX_INPUT_VIEWPORT_RATIO));
}
