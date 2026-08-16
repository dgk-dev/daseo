import { useMemo } from "react";
import { type StyleProp, Text, type TextStyle, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProjectIconImage } from "@/components/project-icon-image";

/**
 * Corner radius of the *generated* project icon — the graphite square with an initial — as a
 * fraction of the box, so it reads as the same shape at 16pt in the sidebar and 40pt in the edit
 * sheet. Fixed tokens did not give that: the radius scale is coarse at the bottom, so small icons
 * landed on 2pt and looked square while large ones were visibly rounder.
 *
 * This is ours to shape. A **user-uploaded icon is never rounded** — it is someone's mark, and
 * clipping its corners distorts branding we don't own. A square logo stays square, a round one is
 * already round.
 */
const RADIUS_RATIO = 0.25;

export function projectIconRadius(size: number): number {
  return Math.round(size * RADIUS_RATIO);
}

/**
 * A project's icon: its chosen image, or a quiet theme-derived square carrying its initial.
 *
 * Geometry lives here, not at the call site. It used to be five copies of the same
 * width/height/radius/centering block, which is how the radius drifted apart in the first
 * place — pass a `size` and the shape follows.
 */

export function ProjectIconView({
  iconDataUri,
  initial,
  size,
  textStyle,
}: {
  iconDataUri: string | null;
  initial: string;
  /** Kept in the shared API; the Daseo fallback intentionally does not derive color from it. */
  projectViewKey: string;
  size: number;
  textStyle: StyleProp<TextStyle>;
}) {
  // The uploaded image is sized but never clipped — see projectIconRadius.
  const box = useMemo(() => ({ width: size, height: size }), [size]);
  const fallbackStyles = useMemo(
    () => [box, { borderRadius: projectIconRadius(size) }, styles.fallback],
    [box, size],
  );
  const textStyles = useMemo(() => [textStyle, styles.fallbackText], [textStyle]);

  const fallback = useMemo(
    () => (
      <View style={fallbackStyles}>
        <Text style={textStyles}>{initial}</Text>
      </View>
    ),
    [fallbackStyles, initial, textStyles],
  );

  return iconDataUri ? (
    <ProjectIconImage dataUri={iconDataUri} fallback={fallback} style={box} />
  ) : (
    fallback
  );
}

const styles = StyleSheet.create((theme) => ({
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
  },
  fallbackText: {
    color: theme.colors.foregroundMuted,
  },
}));
