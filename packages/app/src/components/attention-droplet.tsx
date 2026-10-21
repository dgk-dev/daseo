import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import {
  useAttentionDropletStore,
  type AttentionDropletAlert,
} from "@/stores/attention-droplet-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

/**
 * In-app attention alert, after the Ovis/herdr web UI droplet: a black drop falls from the top
 * safe area, spreads into a card, and its text shows. A tap opens the agent, a drag or flick up
 * puts it away, and it leaves by itself DWELL_MS after its text shows, waiting while touched.
 * Compact screens get one 44pt line as wide as its text; wider screens a two-line card.
 * Reduce motion fades it in and out where it rests.
 */

const DROP_SIZE = 44;
const COMPACT_CARD_HEIGHT = 44;
const WIDE_CARD_HEIGHT = 64;
const COMPACT_MAX_WIDTH = 340;
const WIDE_MAX_WIDTH = 396;
const SIDE_GUTTER = 16;
const TOP_GAP = 8;
const DWELL_MS = 3600;
const SWIPE_DISMISS_DISTANCE = 24;
const SWIPE_DISMISS_VELOCITY = 400;

// A phone sheet's spring (Ovis --ease-spring): fast out of the gate, settling softly.
const SPREAD_EASING = Easing.bezier(0.32, 0.72, 0, 1);
const FOLD_EASING = Easing.bezier(0.2, 0, 0, 1);
const DROP_SPRING = { damping: 18, stiffness: 260, mass: 0.9 } as const;

type Phase = "measuring" | "shown" | "leaving";

export function AttentionDroplet() {
  const current = useAttentionDropletStore((state) => state.current);
  const dismiss = useAttentionDropletStore((state) => state.dismiss);
  const [shown, setShown] = useState<AttentionDropletAlert | null>(null);

  // A newer alert replaces the one on screen only after that one has folded away.
  useEffect(() => {
    if (current && !shown) {
      setShown(current);
    }
  }, [current, shown]);

  const handleGone = useCallback(
    (alert: AttentionDropletAlert) => {
      dismiss(alert.id);
      setShown(null);
    },
    [dismiss],
  );

  if (!shown) {
    return null;
  }

  return (
    <DropletCard
      key={shown.id}
      alert={shown}
      isReplaced={current !== null && current.id !== shown.id}
      onGone={handleGone}
    />
  );
}

interface DropletCardProps {
  alert: AttentionDropletAlert;
  isReplaced: boolean;
  onGone: (alert: AttentionDropletAlert) => void;
}

function DropletCard({ alert, isReplaced, onGone }: DropletCardProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const isCompact = useIsCompactFormFactor();
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("measuring");
  // The phase as the timer, gesture, and replacement callbacks see it, whichever render made them.
  const phaseRef = useRef<Phase>("measuring");
  const [cardWidth, setCardWidth] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(DWELL_MS);
  const deadlineRef = useRef<number | null>(null);

  const cardHeight = isCompact ? COMPACT_CARD_HEIGHT : WIDE_CARD_HEIGHT;
  const maxWidth = Math.min(
    isCompact ? COMPACT_MAX_WIDTH : WIDE_MAX_WIDTH,
    window.width - SIDE_GUTTER * 2,
  );
  // It hangs just under the app header, as the toast does, so it never covers the header controls.
  const top =
    insets.top +
    (isCompact ? HEADER_TOP_PADDING_MOBILE + HEADER_INNER_HEIGHT_MOBILE : HEADER_INNER_HEIGHT) +
    TOP_GAP;
  const hiddenOffset = -(top + DROP_SIZE + 12);

  const translateY = useSharedValue(reduceMotion ? 0 : hiddenOffset);
  const width = useSharedValue(reduceMotion ? 0 : DROP_SIZE);
  const height = useSharedValue(reduceMotion ? cardHeight : DROP_SIZE);
  const shapeOpacity = useSharedValue(reduceMotion ? 0 : 1);
  const contentOpacity = useSharedValue(0);

  const stateLabel =
    alert.reason === "permission"
      ? t("message.attention.permission")
      : t("message.attention.finished");

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const finish = useCallback(() => {
    clearTimer();
    onGone(alert);
  }, [alert, clearTimer, onGone]);

  const leave = useCallback(
    (how: "fold" | "flick") => {
      if (phaseRef.current === "leaving") {
        return;
      }
      clearTimer();
      phaseRef.current = "leaving";
      setPhase("leaving");
      const done = (finished?: boolean) => {
        "worklet";
        if (finished) {
          scheduleOnRN(finish);
        }
      };
      if (reduceMotion) {
        contentOpacity.value = withTiming(0, { duration: 120 });
        shapeOpacity.value = withTiming(0, { duration: 120 }, done);
        return;
      }
      contentOpacity.value = withTiming(0, { duration: 90 });
      if (how === "flick") {
        translateY.value = withTiming(hiddenOffset, { duration: 220, easing: FOLD_EASING }, done);
        return;
      }
      // Fold back into the drop, then rise out of sight: the arrival played backwards, faster.
      width.value = withDelay(60, withTiming(DROP_SIZE, { duration: 180, easing: FOLD_EASING }));
      height.value = withDelay(60, withTiming(DROP_SIZE, { duration: 180, easing: FOLD_EASING }));
      translateY.value = withDelay(
        200,
        withTiming(hiddenOffset, { duration: 200, easing: FOLD_EASING }, done),
      );
    },
    [
      clearTimer,
      contentOpacity,
      finish,
      height,
      hiddenOffset,
      reduceMotion,
      shapeOpacity,
      translateY,
      width,
    ],
  );

  const scheduleLeave = useCallback(
    (delayMs: number) => {
      clearTimer();
      remainingRef.current = delayMs;
      deadlineRef.current = Date.now() + delayMs;
      timerRef.current = setTimeout(() => leave("fold"), delayMs);
    },
    [clearTimer, leave],
  );

  const pauseLeave = useCallback(() => {
    if (deadlineRef.current !== null) {
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
      deadlineRef.current = null;
    }
    clearTimer();
  }, [clearTimer]);

  const resumeLeave = useCallback(() => {
    if (phaseRef.current !== "shown") {
      return;
    }
    scheduleLeave(Math.max(1200, remainingRef.current));
  }, [scheduleLeave]);

  const arrive = useCallback(
    (targetWidth: number) => {
      phaseRef.current = "shown";
      setPhase("shown");
      const showText = (finished?: boolean) => {
        "worklet";
        if (finished) {
          contentOpacity.value = withTiming(1, { duration: 140 });
        }
      };
      if (reduceMotion) {
        width.value = targetWidth;
        height.value = cardHeight;
        shapeOpacity.value = withTiming(1, { duration: 140 }, showText);
      } else {
        // The drop falls into place, then spreads into the card; the text shows once it has.
        translateY.value = withSpring(0, DROP_SPRING);
        width.value = withDelay(
          160,
          withTiming(targetWidth, { duration: 300, easing: SPREAD_EASING }, showText),
        );
        height.value = withDelay(
          160,
          withTiming(cardHeight, { duration: 300, easing: SPREAD_EASING }),
        );
      }
      scheduleLeave(DWELL_MS + (reduceMotion ? 140 : 460));
    },
    [
      cardHeight,
      contentOpacity,
      height,
      reduceMotion,
      scheduleLeave,
      shapeOpacity,
      translateY,
      width,
    ],
  );

  const handleMeasure = useCallback(
    (event: LayoutChangeEvent) => {
      if (phaseRef.current !== "measuring") {
        return;
      }
      // Two spare points: text measured on its own can wrap or clip a glyph short once laid out.
      const measured = Math.ceil(event.nativeEvent.layout.width) + 2;
      const targetWidth = isCompact
        ? Math.max(DROP_SIZE * 3, Math.min(maxWidth, measured))
        : maxWidth;
      setCardWidth(targetWidth);
      arrive(targetWidth);
    },
    [arrive, isCompact, maxWidth],
  );

  useEffect(() => {
    if (isReplaced) {
      leave("fold");
    }
  }, [isReplaced, leave]);

  useEffect(
    () => () => {
      clearTimer();
      cancelAnimation(translateY);
      cancelAnimation(width);
      cancelAnimation(height);
      cancelAnimation(contentOpacity);
      cancelAnimation(shapeOpacity);
    },
    [clearTimer, contentOpacity, height, shapeOpacity, translateY, width],
  );

  const openAgent = useCallback(() => {
    navigateToAgent({
      serverId: alert.serverId,
      workspaceId: alert.workspaceId,
      agentId: alert.agentId,
      pin: true,
    });
    leave("fold");
  }, [alert, leave]);

  const leaveFlick = useCallback(() => leave("flick"), [leave]);
  const springBack = useCallback(() => {
    if (phaseRef.current === "leaving") {
      return;
    }
    translateY.value = withSpring(0, DROP_SPRING);
  }, [translateY]);

  const pan = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onBegin(() => {
      scheduleOnRN(pauseLeave);
    })
    .onUpdate((event) => {
      // Up follows the finger; down only gives a little, so the card reads as pinned to the top.
      translateY.value = event.translationY < 0 ? event.translationY : event.translationY * 0.2;
    })
    .onEnd((event) => {
      const isDismiss =
        event.translationY < -SWIPE_DISMISS_DISTANCE || event.velocityY < -SWIPE_DISMISS_VELOCITY;
      scheduleOnRN(isDismiss ? leaveFlick : springBack);
    })
    .onFinalize(() => {
      scheduleOnRN(resumeLeave);
    });
  const tap = Gesture.Tap().onEnd((_event, success) => {
    if (success) {
      scheduleOnRN(openAgent);
    }
  });
  const gesture = Gesture.Race(pan, tap);

  const shapeStyle = useAnimatedStyle(() => ({
    width: width.value,
    height: height.value,
    borderRadius: Math.min(height.value, DROP_SIZE) / 2,
    opacity: shapeOpacity.value,
    transform: [{ translateY: translateY.value }],
  }));
  const contentStyle = useAnimatedStyle(() => ({ opacity: contentOpacity.value }));

  return (
    <View style={[styles.layer, { top }]} pointerEvents="box-none">
      {phase === "measuring" ? (
        <View style={styles.measurer} pointerEvents="none">
          <View style={[styles.compactRow, { maxWidth }]} onLayout={handleMeasure}>
            <Text style={styles.title} numberOfLines={1}>
              {alert.title}
            </Text>
            <Text
              style={[
                styles.state,
                alert.reason === "permission" ? styles.permission : styles.finished,
              ]}
            >
              {stateLabel}
            </Text>
          </View>
        </View>
      ) : null}
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[styles.shape, shapeStyle]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${alert.title}, ${stateLabel}`}
          accessibilityHint={t("message.attention.open")}
          accessibilityLiveRegion="polite"
          testID="attention-droplet"
        >
          <Animated.View style={[styles.content, { width: cardWidth || maxWidth }, contentStyle]}>
            {isCompact ? (
              <View style={styles.compactRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {alert.title}
                </Text>
                <Text
                  style={[
                    styles.state,
                    alert.reason === "permission" ? styles.permission : styles.finished,
                  ]}
                >
                  {stateLabel}
                </Text>
              </View>
            ) : (
              <View style={styles.wideBody}>
                <View style={styles.wideTitleRow}>
                  <View
                    style={[
                      styles.dot,
                      alert.reason === "permission" ? styles.permissionDot : styles.finishedDot,
                    ]}
                  />
                  <Text style={styles.title} numberOfLines={1}>
                    {alert.title}
                  </Text>
                </View>
                <Text style={styles.detail} numberOfLines={1}>
                  <Text style={alert.reason === "permission" ? styles.permission : styles.finished}>
                    {stateLabel}
                  </Text>
                  {alert.detail ? ` · ${alert.detail}` : ""}
                </Text>
              </View>
            )}
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  layer: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 1000,
    elevation: 1000,
  },
  measurer: {
    position: "absolute",
    top: 0,
    left: 0,
    opacity: 0,
  },
  shape: {
    // Island black in either theme, so the card reads as the device's own surface.
    backgroundColor: theme.colors.palette.black,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadow.md,
  },
  content: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    justifyContent: "center",
  },
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    minWidth: 0,
  },
  wideBody: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
  },
  wideTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.palette.white,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  state: {
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
  },
  detail: {
    // Starts on the title's rail, past the dot and its gap.
    marginLeft: 7 + theme.spacing[2],
    color: theme.colors.palette.zinc[400],
    fontSize: theme.fontSize.xs,
  },
  finished: {
    color: theme.colors.statusDotSuccess,
  },
  permission: {
    color: theme.colors.statusDotWarning,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
  },
  finishedDot: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  permissionDot: {
    backgroundColor: theme.colors.statusDotWarning,
  },
}));
