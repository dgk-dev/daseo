import { memo, useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { BrailleSpinner } from "@/components/braille-spinner";

type LoadingSpinnerSize = "small" | "large" | number;

interface LoadingSpinnerProps {
  color: string;
  size?: LoadingSpinnerSize;
  style?: StyleProp<ViewStyle>;
}

// The box keeps the footprint the platform activity indicator had (20 and 36 for the named sizes,
// the number itself otherwise), so a loading state shifts nothing when this replaced it.
const BOX_SIZE = { small: 20, large: 36 } as const;
const GLYPH_SIZE = { small: 14, large: 28 } as const;

/**
 * Every loading indicator in the app: the braille spinner (components/braille-spinner) centred in
 * the box an activity indicator of the same `size` occupied. It keeps the indicator's
 * `progressbar` role.
 */
export const LoadingSpinner = memo(function LoadingSpinner({
  color,
  size = "small",
  style,
}: LoadingSpinnerProps) {
  const box = typeof size === "number" ? size : BOX_SIZE[size];
  const glyph = typeof size === "number" ? size : GLYPH_SIZE[size];
  const boxStyle = useMemo(
    () => ({
      width: box,
      height: box,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    }),
    [box],
  );
  return (
    <View style={[boxStyle, style]} accessibilityRole="progressbar">
      <BrailleSpinner size={glyph} color={color} />
    </View>
  );
});
