import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

// Daseo delta 55: a terminal list marks its selected row with a pointer, the way fzf and
// lazygit do, instead of a filled row with a rail. The slot is always reserved so selecting a
// row never moves its text; the pointer and the selected title share the one accent color.
export function SidebarSelectionPointer({ selected }: { selected: boolean }) {
  return (
    <View style={styles.slot} pointerEvents="none" aria-hidden>
      {selected ? <Text style={styles.glyph}>{">"}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    width: 8,
    height: 20,
    flexShrink: 0,
    justifyContent: "center",
  },
  glyph: {
    color: theme.colors.accent,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
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
