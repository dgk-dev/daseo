import { AppState, Dimensions } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { resolveWindowCorrection } from "./correction";

let installed = false;

function syncWindowDimensions(reason: string): void {
  const reactNativeWindow = Dimensions.get("window");
  const correction = resolveWindowCorrection({
    reactNativeWindow,
    actualWindow: UnistylesRuntime.screen,
  });
  if (!correction) return;
  // Kept on purpose: `phone_logs` shows each time React Native's window was stale.
  console.warn(
    `[window-dimensions-sync] ${reason}: react-native ${reactNativeWindow.width}x${reactNativeWindow.height} -> ${correction.width}x${correction.height}`,
  );
  // `Dimensions.set` is what the native `didUpdateDimensions` event calls; it notifies every
  // `useWindowDimensions` subscriber. Scale and font scale keep their current values.
  Dimensions.set({
    window: { ...reactNativeWindow, ...correction },
    screen: Dimensions.get("screen"),
  });
}

/**
 * Keeps React Native's window size equal to the real window after a fold or unfold. See
 * correction.ts for why React Native misses it.
 */
export function installWindowDimensionsSync(): void {
  if (installed) return;
  installed = true;
  syncWindowDimensions("start");
  StyleSheet.addChangeListener(() => syncWindowDimensions("unistyles change"));
  AppState.addEventListener("change", (state) => {
    if (state === "active") syncWindowDimensions("resume");
  });
  // A late native event can carry the stale metrics again; put the real size back.
  Dimensions.addEventListener("change", () => syncWindowDimensions("dimensions event"));
}
