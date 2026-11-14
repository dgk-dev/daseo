import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

// Daseo delta 116: the workspace header's controls are words in the sidebar footer's style
// (delta 89) instead of boxed icon buttons: `menu`, `run ▾`, `commit ▾`. The words are command
// vocabulary and stay English in every locale; each control keeps its translated accessibility
// label and tooltip.
export const HEADER_WORDS = {
  menu: "menu",
  run: "run",
  caret: "▾",
} as const;

export type HeaderWordTone = "muted" | "active" | "accent";

/** A header word: muted until its control is hovered, pressed or open; `accent` marks a live state. */
export function HeaderWord({
  children,
  tone = "muted",
}: {
  children: string;
  tone?: HeaderWordTone;
}) {
  return (
    <Text
      style={resolveHeaderWordStyle(tone)}
      numberOfLines={1}
      dataSet={CODE_SURFACE_DATASET}
      selectable={false}
    >
      {children}
    </Text>
  );
}

function resolveHeaderWordStyle(tone: HeaderWordTone) {
  if (tone === "accent") return styles.wordAccent;
  if (tone === "active") return styles.wordActive;
  return styles.word;
}

const styles = StyleSheet.create((theme) => ({
  word: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  wordActive: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  wordAccent: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.accent,
    flexShrink: 0,
  },
}));
