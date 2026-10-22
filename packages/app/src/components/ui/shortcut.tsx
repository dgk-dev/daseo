import React, { useMemo, type ReactElement } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { normalizeDisplayChord } from "@/components/ui/normalize-display-chord";
import { formatShortcut, type ShortcutKey } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

export function Shortcut({
  keys,
  chord,
  style,
  textStyle,
}: {
  keys?: ShortcutKey[];
  chord?: ShortcutKey[][];
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}): ReactElement | null {
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const displayChord = normalizeDisplayChord(chord, keys);
  const shortcutOs = getShortcutOs();

  const badgeStyle = useMemo(() => [styles.badge, style], [style]);
  const textCombinedStyle = useMemo(() => [styles.text, textStyle], [textStyle]);
  const sequenceStyle = useMemo(() => [styles.sequence, style], [style]);

  if (!shortcutsAvailable) {
    return null;
  }

  const singleCombo = displayChord?.[0];
  // Render nothing, literally — an empty <View> would still consume the
  // parent's `gap` and leave a phantom slot where the badge used to be.
  if (!displayChord || !singleCombo) {
    return null;
  }

  if (displayChord.length === 1) {
    return (
      <View style={badgeStyle} dataSet={CODE_SURFACE_DATASET}>
        <Text style={textCombinedStyle}>{formatShortcut(singleCombo, shortcutOs)}</Text>
      </View>
    );
  }

  return (
    <View style={sequenceStyle} dataSet={CODE_SURFACE_DATASET}>
      {displayChord.map(function (combo) {
        return (
          <View key={combo.join("+")} style={styles.badge}>
            <Text style={textCombinedStyle}>{formatShortcut(combo, shortcutOs)}</Text>
          </View>
        );
      })}
    </View>
  );
}

// Daseo delta 51: a shortcut is a keycap: mono text in a hairline-bordered key, as a
// terminal tool prints its key hints.
const styles = StyleSheet.create((theme) => ({
  badge: {
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  sequence: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  text: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
}));
