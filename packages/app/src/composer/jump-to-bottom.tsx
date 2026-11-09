import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  HINT_LINE_HIT_SLOP,
  HINT_LINE_LABELS,
  HintWord,
  hintLineStyles,
} from "@/composer/hint-line";

// Daseo delta 89: on desktop "jump to the newest message" is a word at the right end of the
// composer hint line (`↓ bottom`) instead of a button floating over the transcript, so it never
// covers a code block or a table. The agent panel owns one bridge per pane: the stream view
// publishes whether the jump is needed and its handler (the same condition and handler the
// floating button uses); the hint line reads it. Without a bridge (a stream view with no
// composer) and on phones, the stream view keeps its floating button.

export interface JumpToBottomState {
  visible: boolean;
  jump: (() => void) | null;
}

export interface JumpToBottomBridge {
  get: () => JumpToBottomState;
  set: (next: JumpToBottomState) => void;
  subscribe: (listener: () => void) => () => void;
}

const HIDDEN: JumpToBottomState = { visible: false, jump: null };

export function createJumpToBottomBridge(): JumpToBottomBridge {
  let state = HIDDEN;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      if (next.visible === state.visible && next.jump === state.jump) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const JumpToBottomBridgeContext = createContext<JumpToBottomBridge | null>(null);

/** One bridge for the lifetime of the pane that renders both the stream and the composer. */
export function useCreateJumpToBottomBridge(): JumpToBottomBridge {
  const [bridge] = useState(createJumpToBottomBridge);
  return bridge;
}

export function useJumpToBottomBridge(): JumpToBottomBridge | null {
  return useContext(JumpToBottomBridgeContext);
}

/**
 * The stream view's side: keep the pane's bridge in step with the jump condition and handler.
 * Returns whether the stream view still draws its own floating button: on phones, and where no
 * composer reads the bridge.
 */
export function useJumpToBottom(visible: boolean, jump: () => void): boolean {
  const bridge = useJumpToBottomBridge();
  const isCompact = useIsCompactFormFactor();
  useEffect(() => {
    bridge?.set({ visible, jump });
  }, [bridge, visible, jump]);
  useEffect(() => {
    if (!bridge) return;
    return () => bridge.set(HIDDEN);
  }, [bridge]);
  return visible && (isCompact || bridge === null);
}

const subscribeNoop = () => () => {};
const getHidden = () => HIDDEN;

/**
 * `↓ bottom` on the desktop hint line while the transcript is scrolled away from the end. The
 * word keeps its place when hidden (invisible, not pressable, not announced), so the hint line
 * never rewraps, and the composer never changes height, as the reader scrolls.
 */
export function JumpToBottomHint() {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const bridge = useJumpToBottomBridge();
  const state = useSyncExternalStore(
    bridge?.subscribe ?? subscribeNoop,
    bridge?.get ?? getHidden,
    bridge?.get ?? getHidden,
  );
  if (isCompact || !bridge) return null;
  const jump = state.visible ? state.jump : null;
  if (!jump) {
    return (
      <View style={RESERVED_STYLE} aria-hidden>
        <HintWord>{JUMP_TO_BOTTOM_WORD}</HintWord>
      </View>
    );
  }
  return (
    <Pressable
      onPress={jump}
      accessibilityRole="button"
      accessibilityLabel={t("agentStream.scrollToBottom")}
      testID="scroll-to-bottom-button"
      style={hintLineStyles.control}
      hitSlop={HINT_LINE_HIT_SLOP}
    >
      {({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => (
        <HintWord active={Boolean(hovered) || pressed}>{JUMP_TO_BOTTOM_WORD}</HintWord>
      )}
    </Pressable>
  );
}

const JUMP_TO_BOTTOM_WORD = `${HINT_LINE_LABELS.bottomArrow} ${HINT_LINE_LABELS.bottom}`;

const jumpStyles = StyleSheet.create(() => ({
  hidden: { opacity: 0, pointerEvents: "none" },
}));
const RESERVED_STYLE = [hintLineStyles.control, jumpStyles.hidden];
