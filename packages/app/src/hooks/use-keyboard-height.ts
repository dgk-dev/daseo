import { useKeyboardState } from "react-native-keyboard-controller";

/**
 * Height of the software keyboard on screen, in dp; 0 while it is hidden.
 *
 * Daseo delta 59: the Composer caps its own growth by this. With KeyboardProvider's
 * edge-to-edge mode the window is not resized for the keyboard, so `useWindowDimensions`
 * keeps the full height and a cap derived from it alone reaches above the header.
 */
export function useKeyboardHeight(): number {
  return useKeyboardState((state) => (state.isVisible ? state.height : 0));
}
