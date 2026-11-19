import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * The left padding of every sidebar row (workspace, project header, New workspace, Show more,
 * status group). Rows take it from here so their leading icon and the project header's `~/name`
 * share one x, the same x as the sidebar's own entries above the list.
 */
export const SIDEBAR_ROW_INSET = 8;

// Daseo delta 55: a terminal list marks its selected row with a pointer, the way fzf and
// lazygit do, instead of a filled row with a rail. 2026-11-19 (delta 113 amended): the pointer
// no longer reserves a column. It is drawn inside the row's left padding, left of the leading
// icon, so rows sit flush left and selecting a row still never moves its text. Place it as the
// first child of a row's leading flex row; it hangs out to the left by the row inset.
export function SidebarSelectionPointer({ selected }: { selected: boolean }) {
  if (!selected) return null;
  return (
    <View style={styles.slot} pointerEvents="none" aria-hidden>
      <Text style={styles.glyph}>{">"}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    position: "absolute",
    left: -SIDEBAR_ROW_INSET,
    top: 0,
    width: SIDEBAR_ROW_INSET,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  glyph: {
    color: theme.colors.accent,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 20,
  },
}));

export const sidebarSelectedTitleStyles = StyleSheet.create((theme) => ({
  title: {
    color: theme.colors.accent,
    opacity: 1,
    fontWeight: theme.fontWeight.semibold,
  },
}));
