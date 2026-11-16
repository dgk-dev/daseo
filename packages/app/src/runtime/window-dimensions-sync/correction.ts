// Daseo delta 124. React Native 0.81 re-reads the Android display metrics only when the
// rotation changes (ReactRootView.checkForDeviceOrientationChanges; the configuration-change
// path sits behind a feature flag that is off, and facebook/react-native#53467 was closed
// unmerged). The app is portrait-locked, so folding or unfolding a Galaxy Fold never updates
// `Dimensions` / `useWindowDimensions`: a process started unfolded keeps an 875 dp window on
// the 480 dp cover screen. Unistyles reads the Activity's current window bounds, so the
// breakpoint says "compact" while every width taken from React Native is still the unfolded
// one. The left panel was then 875 dp wide on a 480 dp screen and its right edge (row kebabs,
// project + buttons, the close X, the footer's settings word) was clipped off screen.

export interface WindowSize {
  width: number;
  height: number;
}

/** A size difference below this is rounding between the two native readers, not a fold. */
const TOLERANCE_DP = 1;

/**
 * The size React Native should report, or null when it already agrees with the real window.
 * Width alone decides: a height-only difference is the two readers disagreeing about system
 * bars, which is not ours to settle.
 */
export function resolveWindowCorrection(input: {
  reactNativeWindow: WindowSize;
  actualWindow: WindowSize;
}): WindowSize | null {
  const { reactNativeWindow, actualWindow } = input;
  if (!isUsableSize(actualWindow)) return null;
  if (Math.abs(reactNativeWindow.width - actualWindow.width) <= TOLERANCE_DP) return null;
  return { width: actualWindow.width, height: actualWindow.height };
}

function isUsableSize(size: WindowSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}
