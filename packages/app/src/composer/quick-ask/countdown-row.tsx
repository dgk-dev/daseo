import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";

/** Daseo delta 64: "sending in 1.2 s · tap to edit" above a quick-ask transcript. */
export function QuickAskCountdownRow({
  remainingMs,
  onCancel,
}: {
  /** Null outside the countdown; the row renders nothing then. */
  remainingMs: number | null;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (remainingMs === null) {
    return null;
  }
  return (
    <Pressable
      onPress={onCancel}
      hitSlop={8}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={t("composer.quickAsk.cancelAccessibilityLabel")}
      testID="quick-ask-countdown"
    >
      <Text style={styles.text}>
        {t("composer.quickAsk.countdown", { seconds: (remainingMs / 1000).toFixed(1) })}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    alignSelf: "stretch",
    paddingVertical: theme.spacing[1],
  },
  text: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
  },
}));
