import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * Daseo delta 89: a sidebar section title drawn as a terminal rule, `── workspaces ──`. The rule
 * is in the border colour and the title in muted text, so the section reads as a divider and
 * not as one more row. The rule and the trailing mark are drawing, hidden from assistive tech.
 */
export function SidebarSectionRule({
  title,
  trailing,
  tone,
}: {
  title: string;
  trailing?: string;
  /** `warning`: the section waits on the owner (the task sidebar's decisions, delta 101). */
  tone?: "warning";
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rule} selectable={false} aria-hidden>
        {"── "}
      </Text>
      <Text
        style={[styles.title, tone === "warning" && styles.warningTitle]}
        numberOfLines={1}
        selectable={false}
      >
        {title}
      </Text>
      <Text style={styles.rule} selectable={false} aria-hidden>
        {" ──"}
      </Text>
      {trailing ? (
        <Text style={styles.trailing} selectable={false} aria-hidden>
          {trailing}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    flexShrink: 1,
  },
  rule: {
    color: theme.colors.border,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    minWidth: 0,
    flexShrink: 1,
  },
  warningTitle: {
    color: theme.colors.statusWarning,
  },
  trailing: {
    marginLeft: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
}));
