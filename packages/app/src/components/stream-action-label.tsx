import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

// Daseo delta 89: actions under a message (copy, fork, undo) are words on the metadata line, the
// way a terminal tool names its commands, instead of icons. The words are command vocabulary and
// stay English in every locale, like shortcut key names (docs/i18n.md); each control keeps its
// translated accessibility label.
export const STREAM_ACTION_LABELS = {
  copy: "copy",
  copied: "copied",
  fork: "fork",
  undo: "undo",
} as const;

// The metadata line is 24 high; this grows the touch target to 44 without moving the words.
export const STREAM_ACTION_HIT_SLOP = { top: 10, bottom: 10, left: 6, right: 6 } as const;

// Matches STREAM_METADATA_FONT_SIZE in components/message.tsx (imported there from here would
// make a cycle).
const STREAM_ACTION_FONT_SIZE = 13;

export function StreamActionLabel({ label, active }: { label: string; active: boolean }) {
  return (
    <Text
      style={active ? styles.labelActive : styles.label}
      dataSet={CODE_SURFACE_DATASET}
      selectable={false}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: STREAM_ACTION_FONT_SIZE,
  },
  labelActive: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: STREAM_ACTION_FONT_SIZE,
  },
}));
