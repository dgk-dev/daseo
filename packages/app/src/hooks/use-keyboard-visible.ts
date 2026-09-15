import { useEffect, useState } from "react";
import { Keyboard } from "react-native";
import { isNative } from "@/constants/platform";

/**
 * Whether the software keyboard is on screen.
 *
 * Native only: on web the browser never reports this, and layouts there are not
 * resized by a keyboard the way a bottom sheet is.
 */
export function useKeyboardVisible(enabled = true): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled || !isNative) {
      setVisible(false);
      return;
    }
    const show = Keyboard.addListener("keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [enabled]);

  return visible;
}
