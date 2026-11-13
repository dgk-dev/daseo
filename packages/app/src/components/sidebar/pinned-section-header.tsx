import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
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
  return (
    <SidebarSectionHeader
      title={t("sidebar.pinned.title").toLowerCase()}
      collapsed={collapsed}
      onToggle={onToggle}
      testID="sidebar-pinned-section-header"
    />
  );
}

/**
 * A sidebar section's `── title ──` header in its row box. With `onToggle` it folds the section
 * and shows the state as ▸/▾ (Daseo delta 89); without it, it only names the section. Shared by
 * the pinned section and the task sidebar's sections (delta 101).
 */
export function SidebarSectionHeader({
  title,
  tone,
  collapsed = false,
  onToggle,
  testID,
}: {
  title: string;
  tone?: "warning";
  collapsed?: boolean;
  onToggle?: () => void;
  testID?: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const stateMark = collapsed ? "▸" : "▾";

  if (!onToggle) {
    return (
      <View style={styles.header} accessibilityRole="header" testID={testID}>
        <SidebarSectionRule title={title} tone={tone} />
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onToggle}
      style={styles.header}
      testID={testID}
    >
      {/* Daseo delta 89: `── pinned ──`, with the collapse state as ▸/▾ where the chevron was. */}
      {({ hovered }) => (
        <SidebarSectionRule
          title={title}
          tone={tone}
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
