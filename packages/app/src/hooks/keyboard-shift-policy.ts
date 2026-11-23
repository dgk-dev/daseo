export const DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT = 120;

export function resolveKeyboardShift(input: {
  rawKeyboardHeight: number;
  keyboardProgress: number;
  bottomInset: number;
  isIos: boolean;
  iosMinHeight: number;
}): number {
  "worklet";

  if (!(input.keyboardProgress > 0) || !(input.rawKeyboardHeight > 0)) {
    return 0;
  }

  // iOS can report a small accessory/prediction bar height during touch focus.
  // Treat that as non-keyboard so layouts don't "bounce" while interacting.
  if (input.isIos && input.rawKeyboardHeight < input.iosMinHeight) {
    return 0;
  }

  return Math.max(0, input.rawKeyboardHeight - input.bottomInset);
}

/**
 * Daseo delta 147. Whether the keyboard offset must be zeroed after the app comes back to the
 * foreground: the system says no keyboard is on screen, yet the offset still holds one. Leaving
 * the app with the keyboard open can lose the "keyboard hidden" transition, and the Composer then
 * stays one keyboard height above the bottom over the chat.
 */
export function shouldResetKeyboardOffsetOnResume(input: {
  systemKeyboardVisible: boolean;
  rawKeyboardHeight: number;
  keyboardProgress: number;
}): boolean {
  if (input.systemKeyboardVisible) return false;
  return input.rawKeyboardHeight > 0 || input.keyboardProgress > 0;
}
