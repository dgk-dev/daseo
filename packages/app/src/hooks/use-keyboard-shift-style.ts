import { createElement, useEffect, useMemo, type ReactNode } from "react";
import { AppState, Keyboard, Platform } from "react-native";
import type { ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGenericKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import {
  DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT,
  resolveKeyboardShift,
  shouldResetKeyboardOffsetOnResume,
} from "@/hooks/keyboard-shift-policy";
import { KeyboardShiftContext, useKeyboardShift } from "@/hooks/keyboard-shift-context";
import { SHADOW_TREE_COMMIT_PIN } from "@/utils/reanimated-commit-path";

type KeyboardShiftMode = "translate" | "padding";

/** After a resume: check the keyboard once the window settled, then push the fresh offset again. */
const RESUME_CHECK_DELAYS_MS = [400, 1200] as const;
/** Too small to see; it only makes the animated style differ so Reanimated sends it again. */
const RESUME_NUDGE_DP = 0.01;

export function KeyboardShiftProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const bottomInset = useSharedValue(insets.bottom);
  const resumeNudge = useSharedValue(0);
  const isIos = Platform.OS === "ios";

  useEffect(() => {
    bottomInset.value = insets.bottom;
  }, [bottomInset, insets.bottom]);

  useGenericKeyboardHandler(
    {
      onEnd: (event) => {
        "worklet";
        if (isIos) {
          keyboardHeight.value = -event.height;
          keyboardProgress.value = event.progress;
        }
      },
    },
    [isIos, keyboardHeight, keyboardProgress],
  );

  // Daseo delta 147 (Android): leaving the app with the keyboard open sometimes left the Composer
  // floating one keyboard height above the bottom after the return, over the chat. Two known
  // causes: the keyboard library can miss the hide while the app is in the background, and
  // Reanimated 4.3 can restore stale animated props after a pause (software-mansion/
  // react-native-reanimated#9574, fixed in 4.6). On every resume: zero an offset the system no
  // longer backs with a keyboard (React Native's own check reads the root window's IME insets),
  // then nudge the style twice so the live value is sent to the native views again.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const check = (step: number) => {
      const systemKeyboardVisible = Keyboard.isVisible();
      const rawKeyboardHeight = Math.abs(keyboardHeight.value);
      const progress = keyboardProgress.value;
      const reset = shouldResetKeyboardOffsetOnResume({
        systemKeyboardVisible,
        rawKeyboardHeight,
        keyboardProgress: progress,
      });
      if (reset) {
        keyboardHeight.value = 0;
        keyboardProgress.value = 0;
      }
      resumeNudge.value = step === 0 ? RESUME_NUDGE_DP : 0;
      // Kept on purpose: `phone_logs` shows what each resume found.
      console.info(
        `[keyboard-resume] step ${step}: system keyboard ${systemKeyboardVisible ? "open" : "closed"}, offset height ${rawKeyboardHeight.toFixed(1)} progress ${progress.toFixed(2)}${reset ? " -> reset to 0" : ""}`,
      );
    };
    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
    };
    const scheduleChecks = () => {
      RESUME_CHECK_DELAYS_MS.forEach((delay, step) => {
        timers.push(setTimeout(check, delay, step));
      });
    };
    const subscription = AppState.addEventListener("change", (state) => {
      clearTimers();
      if (state === "active") scheduleChecks();
    });
    return () => {
      subscription.remove();
      clearTimers();
    };
  }, [keyboardHeight, keyboardProgress, resumeNudge]);

  const shift = useDerivedValue(() => {
    "worklet";
    return resolveKeyboardShift({
      rawKeyboardHeight: Math.abs(keyboardHeight.value),
      keyboardProgress: keyboardProgress.value,
      bottomInset: bottomInset.value,
      isIos,
      iosMinHeight: DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT,
    });
  });

  const value = useMemo(
    () => ({
      shift,
      bottomInset,
      resumeNudge,
    }),
    [bottomInset, resumeNudge, shift],
  );

  return createElement(KeyboardShiftContext.Provider, { value }, children);
}

export function useKeyboardShiftStyle(input: { mode: KeyboardShiftMode; enabled?: boolean }): {
  shift: SharedValue<number>;
  style: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
} {
  const { shift, bottomInset, resumeNudge } = useKeyboardShift();
  const mode = input.mode;
  const enabled = input.enabled ?? true;

  const style = useAnimatedStyle<ViewStyle>(() => {
    "worklet";
    if (mode === "padding") {
      if (!enabled) {
        return { paddingBottom: 0 };
      }
      // Include safe-area bottom inset so content clears the home indicator even without a keyboard.
      return { paddingBottom: bottomInset.value + shift.value + resumeNudge.value };
    }

    // Composers and callouts move their buttons with the keyboard; see SHADOW_TREE_COMMIT_PIN.
    return {
      transform: [{ translateY: enabled ? resumeNudge.value - shift.value : 0 }],
      ...SHADOW_TREE_COMMIT_PIN,
    };
  }, [enabled, mode]);

  return { shift, style };
}
