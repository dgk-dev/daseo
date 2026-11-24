import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Text, type Text as NativeText } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { registerSpinnerNode } from "@/components/braille-spinner/dom-frames.web";
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_STATIC,
} from "@/components/braille-spinner/frames";
import { glyphStyles } from "@/components/braille-spinner/glyph-style";
import type { BrailleSpinnerProps } from "@/components/braille-spinner/types";

/**
 * Web braille spinner: a text glyph whose frame the shared clock writes straight into the DOM
 * (see dom-frames.web.ts). It moves only while its retained panel is active and reduce motion is
 * off; otherwise it shows the static glyph and holds no subscription.
 */
export const BrailleSpinner = memo(function BrailleSpinner({
  size,
  color,
  testID,
}: BrailleSpinnerProps) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const animate = active && !reduceMotion;
  const node = useRef<HTMLElement | null>(null);
  const setNode = useCallback((instance: NativeText | null) => {
    node.current = instance instanceof HTMLElement ? instance : null;
  }, []);

  useLayoutEffect(() => {
    const element = node.current;
    if (!animate || !element) return;
    return registerSpinnerNode(element);
  }, [animate]);

  const sizeStyle = useMemo(() => ({ fontSize: size, lineHeight: size, color }), [color, size]);

  return (
    <Text
      ref={setNode}
      style={[glyphStyles.glyph, sizeStyle]}
      selectable={false}
      aria-hidden
      testID={testID}
    >
      {animate ? BRAILLE_SPINNER_FRAMES[0] : BRAILLE_SPINNER_STATIC}
    </Text>
  );
});
