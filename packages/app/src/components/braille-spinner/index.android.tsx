import { memo, useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { requireNativeViewManager } from "expo-modules-core";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type { BrailleSpinnerProps } from "@/components/braille-spinner/types";

interface NativeBrailleSpinnerProps {
  spinning: boolean;
  color: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  importantForAccessibility?: "no";
}

// modules/daseo-braille-spinner: the dots are drawn natively. D2Coding has no braille block, so a
// text glyph here would be whatever the system falls back to; the view also keeps the motion off
// the JS thread (one process-wide 10 Hz ticker, only while a spinner is visible).
const NativeBrailleSpinner =
  requireNativeViewManager<NativeBrailleSpinnerProps>("DaseoBrailleSpinner");

// One monospace cell: the mono face's advance is 0.6 em; the line box is the font size.
const CELL_WIDTH_EM = 0.6;

/**
 * Android braille spinner. Colour is a plain native prop (callers theme it with withUnistyles),
 * never a theme-tracked style (docs/unistyles.md). It moves only while its retained panel is
 * active and reduce motion is off, and the view itself stops when it or its window is hidden.
 */
export const BrailleSpinner = memo(function BrailleSpinner({
  size,
  color,
  testID,
}: BrailleSpinnerProps) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const style = useMemo(() => ({ width: Math.round(size * CELL_WIDTH_EM), height: size }), [size]);
  return (
    <NativeBrailleSpinner
      spinning={active && !reduceMotion}
      color={color}
      style={style}
      testID={testID}
      importantForAccessibility="no"
    />
  );
});
