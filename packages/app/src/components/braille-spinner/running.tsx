import { memo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import { getStatusDotColor } from "@/utils/status-dot-color";

/**
 * "An agent is running": the braille spinner in the running colour, in a fixed square frame so a
 * status slot never changes size between states. With a `backdrop` the frame is filled with the
 * surface behind it, a knockout that separates the spinner from the icon it overlaps (tab agent
 * icon, project icon badge). Callers place the frame; `getRunningSpinnerOffset` re-anchors a
 * corner dot's offset for it.
 */
export const RUNNING_SPINNER_FRAME_SIZE = 14;
// Larger than the frame on purpose: braille fallback faces draw the dots well inside the em.
const RUNNING_SPINNER_GLYPH_SIZE = 16;

export function getRunningSpinnerOffset(dotOffset: number, dotSize: number): number {
  return dotOffset - (RUNNING_SPINNER_FRAME_SIZE - dotSize) / 2;
}

const ThemedBrailleSpinner = withUnistyles(BrailleSpinner, (theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? theme.colors.accent,
}));

export const RunningSpinner = memo(function RunningSpinner({
  backdrop = null,
  testID,
}: {
  backdrop?: SurfaceBackdrop | null;
  testID?: string;
}) {
  return (
    <View style={[styles.frame, getBackdropStyle(backdrop)]}>
      <ThemedBrailleSpinner size={RUNNING_SPINNER_GLYPH_SIZE} testID={testID} />
    </View>
  );
});

function getBackdropStyle(backdrop: SurfaceBackdrop | null) {
  switch (backdrop) {
    case "surface0":
      return styles.backdropSurface0;
    case "surface1":
      return styles.backdropSurface1;
    case "surfaceSidebar":
      return styles.backdropSurfaceSidebar;
    case "surfaceSidebarHover":
      return styles.backdropSurfaceSidebarHover;
    case "surface2":
      return styles.backdropSurface2;
    default:
      return null;
  }
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    width: RUNNING_SPINNER_FRAME_SIZE,
    height: RUNNING_SPINNER_FRAME_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  backdropSurface0: { backgroundColor: theme.colors.surface0 },
  backdropSurface1: { backgroundColor: theme.colors.surface1 },
  backdropSurfaceSidebar: { backgroundColor: theme.colors.surfaceSidebar },
  backdropSurfaceSidebarHover: { backgroundColor: theme.colors.surfaceSidebarHover },
  backdropSurface2: { backgroundColor: theme.colors.surface2 },
}));
