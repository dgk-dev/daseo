import { createContext, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Shortcut } from "@/components/ui/shortcut";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

// Daseo delta 89: under the prompt line the composer prints one line of text controls, the way a
// terminal tool prints its key hints: `model opus ▾  effort high ▾  ⏎ send  ⇧⏎ newline …`. Each
// word is the existing control restyled (same handler, menu, accessibility label, testID); a
// keycap appears only for a shortcut the keyboard registry actually binds, and Shortcut renders
// nothing where shortcuts are unavailable (phones), so compact layouts get the words alone.
//
// The words are command vocabulary and stay English in every locale, like shortcut key names
// (docs/i18n.md); accessibility labels stay translated.
export const HINT_LINE_LABELS = {
  model: "model",
  effort: "effort",
  mode: "mode",
  features: "features",
  send: "send",
  newline: "newline",
  focus: "focus",
  commands: "commands",
  files: "files",
  attach: "attach",
  dictate: "dictate",
  voice: "voice",
  mute: "mute",
  unmute: "unmute",
  interrupt: "interrupt",
  bottom: "bottom",
  bottomArrow: "↓",
} as const;

export const HINT_LINE_CARET = "▾";
export const HINT_LINE_RECORDING_MARK = "●";

// The hint line is 24 high on desktop; on phones this grows every control's touch target to 44.
export const HINT_LINE_HIT_SLOP = { top: 10, bottom: 10, left: 4, right: 4 } as const;

export const HINT_LINE_FONT_SIZE = 13;

/**
 * The hint line's measured width. The agent controls size to their words and wrap with the rest
 * of the line, so they read their density budget (labels and carets shown or dropped) from the
 * whole line instead of from their own box. Null until the line has laid out.
 */
export const HintLineWidthContext = createContext<number | null>(null);

function resolveHintWordStyle({ active, accent }: { active: boolean; accent: boolean }) {
  if (accent) return hintLineStyles.wordAccent;
  if (active) return hintLineStyles.wordActive;
  return hintLineStyles.word;
}

/**
 * A command word, muted until its control is hovered, pressed, or open. `accent` marks the one
 * word that acts now (send, when there is something to send).
 */
export function HintWord({
  children,
  active = false,
  accent = false,
}: {
  children: ReactNode;
  active?: boolean;
  accent?: boolean;
}) {
  return (
    <Text
      style={resolveHintWordStyle({ active, accent })}
      numberOfLines={1}
      dataSet={CODE_SURFACE_DATASET}
      selectable={false}
    >
      {children}
    </Text>
  );
}

/** The current value of a control (the selected model, effort, mode), in the accent. */
export function HintValue({ children }: { children: ReactNode }) {
  return (
    <Text
      style={hintLineStyles.value}
      numberOfLines={1}
      dataSet={CODE_SURFACE_DATASET}
      selectable={false}
    >
      {children}
    </Text>
  );
}

export function HintCaret() {
  return (
    <Text style={hintLineStyles.caret} dataSet={CODE_SURFACE_DATASET} selectable={false}>
      {HINT_LINE_CARET}
    </Text>
  );
}

/**
 * A key hint that is not a control: `⇧⏎ newline`. Renders nothing where its keycap would not
 * show (no binding, or a phone without a keyboard), so the word never stands alone.
 */
export function HintKey({
  chord,
  label,
}: {
  chord: ShortcutKey[][] | null | undefined;
  label: string;
}) {
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  if (!shortcutsAvailable || !chord || chord.length === 0) return null;
  return (
    <View style={hintLineStyles.keyHint}>
      <HintKeycap chord={chord} />
      <HintWord>{label}</HintWord>
    </View>
  );
}

export function HintKeycap({ chord }: { chord: ShortcutKey[][] | null | undefined }) {
  if (!chord || chord.length === 0) return null;
  return <Shortcut chord={chord} />;
}

export const hintLineStyles = StyleSheet.create((theme) => ({
  // The control box: text only, no fill, border, or radius in any state.
  control: {
    minHeight: 24,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: 2,
    backgroundColor: "transparent",
  },
  controlDisabled: {
    opacity: theme.opacity[50],
  },
  keyHint: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: 2,
  },
  word: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: HINT_LINE_FONT_SIZE,
    flexShrink: 0,
  },
  wordActive: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: HINT_LINE_FONT_SIZE,
    flexShrink: 0,
  },
  wordAccent: {
    color: theme.colors.accent,
    fontFamily: theme.fontFamily.mono,
    fontSize: HINT_LINE_FONT_SIZE,
    flexShrink: 0,
  },
  wordRecording: {
    color: theme.colors.destructive,
    fontFamily: theme.fontFamily.mono,
    fontSize: HINT_LINE_FONT_SIZE,
    flexShrink: 0,
  },
  value: {
    color: theme.colors.accent,
    fontFamily: theme.fontFamily.mono,
    fontSize: HINT_LINE_FONT_SIZE,
    minWidth: 0,
    flexShrink: 1,
  },
  caret: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: HINT_LINE_FONT_SIZE,
    flexShrink: 0,
  },
}));
