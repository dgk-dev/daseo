import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { SidebarSectionRule } from "@/components/sidebar/sidebar-section-rule";

export function PinnedSectionHeader({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const stateMark = collapsed ? "▸" : "▾";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onToggle}
      style={styles.header}
      testID="sidebar-pinned-section-header"
    >
      {/* Daseo delta 89: `── pinned ──`, with the collapse state as ▸/▾ where the chevron was. */}
      {({ hovered }) => (
        <SidebarSectionRule
          title={t("sidebar.pinned.title").toLowerCase()}
          trailing={hovered || isNative || isCompact ? stateMark : undefined}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
  },
}));
