import { memo } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { requireNativeViewManager } from "expo-modules-core";
import { withUnistyles } from "react-native-unistyles";
import {
  StatusRingFrame,
  type StatusRingProps,
  rotatorStyles,
} from "@/components/status-ring/frame";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { getStatusDotColor } from "@/utils/status-dot-color";

interface NativeStatusRingArcProps {
  spinning: boolean;
  color: string;
  style?: StyleProp<ViewStyle>;
}

// modules/daseo-status-ring: the turning quarter, drawn and turned on the RenderThread.
const NativeStatusRingArc = requireNativeViewManager<NativeStatusRingArcProps>("DaseoStatusRing");

// The arc's colour is a native prop rather than a style, so it follows the theme through
// withUnistyles (docs/unistyles.md, alternative 3): only this leaf re-renders on a theme change.
const ThemedStatusRingArc = withUnistyles(NativeStatusRingArc, (theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? "transparent",
}));

/**
 * Android running indicator (Daseo delta 88). The frame (knockout, track, centre dot) is the
 * same React Native view as on iOS; the turning quarter is a native view whose rotation runs on
 * the RenderThread, so a screen with running agents no longer wakes the main thread, Reanimated
 * or the composer's cursor listener on every frame. It turns only while its retained panel is
 * on screen and reduce motion is off (delta 87's gating), and stops by itself when the view or
 * window is hidden. iOS keeps index.tsx (one Reanimated UI-thread clock); web keeps index.web.tsx.
 */
export const StatusRing = memo(function StatusRing({ backdrop }: StatusRingProps) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();

  return (
    <StatusRingFrame backdrop={backdrop}>
      <ThemedStatusRingArc spinning={active && !reduceMotion} style={rotatorStyles.rotator} />
    </StatusRingFrame>
  );
});
