import { memo, useMemo } from "react";
import { Text } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useSpinnerFrame } from "@/components/braille-spinner/clock";
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_STATIC,
} from "@/components/braille-spinner/frames";
import { glyphStyles } from "@/components/braille-spinner/glyph-style";
import type { BrailleSpinnerProps } from "@/components/braille-spinner/types";

/**
 * iOS braille spinner: a text glyph re-rendered on the shared JS clock (only this leaf renders on
 * a tick). Android has index.android.tsx (native dots), web index.web.tsx (direct text writes).
 */
export const BrailleSpinner = memo(function BrailleSpinner({
  size,
  color,
  testID,
}: BrailleSpinnerProps) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const animate = active && !reduceMotion;
  const frame = useSpinnerFrame(animate);
  const sizeStyle = useMemo(() => ({ fontSize: size, lineHeight: size, color }), [color, size]);
  return (
    <Text
      style={[glyphStyles.glyph, sizeStyle]}
      selectable={false}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID={testID}
    >
      {animate
        ? BRAILLE_SPINNER_FRAMES[frame % BRAILLE_SPINNER_FRAMES.length]
        : BRAILLE_SPINNER_STATIC}
    </Text>
  );
});
