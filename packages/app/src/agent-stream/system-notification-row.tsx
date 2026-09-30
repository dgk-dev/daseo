import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { formatMessageTimestamp } from "@/utils/time";
import {
  formatSystemNotificationLabel,
  parseSystemNotification,
  type SystemNotificationSummary,
} from "./system-notification";

const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevronRight = withUnistyles(ChevronRight, chevronColorMapping);
const ThemedChevronDown = withUnistyles(ChevronDown, chevronColorMapping);

const HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 } as const;

/**
 * Boundary where a turn triggered by a Paseo system prompt begins: what
 * triggered it and when. The full prompt body stays folded until tapped.
 * A background-wait wake is not a new request, so it renders as one compact
 * line instead of a divider (info color; warning when the wait timed out).
 */
export const SystemNotificationRow = memo(function SystemNotificationRow({
  text,
  timestamp,
}: {
  text: string;
  timestamp: number;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const notification = useMemo(() => parseSystemNotification(text), [text]);
  const label = formatSystemNotificationLabel(notification.summary, t);
  const time = useMemo(() => formatMessageTimestamp(new Date(timestamp)), [timestamp]);
  const handlePress = useCallback(() => setExpanded((previous) => !previous), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const { summary } = notification;
  const isWait = summary.kind === "wait";
  const labelStyle = resolveLabelStyle(summary);

  return (
    <View
      style={isWait ? stylesheet.waitContainer : stylesheet.container}
      testID={isWait ? "system-notification-wait-row" : "system-notification-row"}
    >
      <View style={stylesheet.divider}>
        {isWait ? null : <View style={stylesheet.line} />}
        <Pressable
          onPress={handlePress}
          accessibilityRole="button"
          accessibilityState={accessibilityState}
          accessibilityLabel={t(
            expanded
              ? "message.systemNotification.hideNotification"
              : "message.systemNotification.showNotification",
            { label },
          )}
          testID="system-notification-toggle"
          style={stylesheet.toggle}
          hitSlop={HIT_SLOP}
        >
          {expanded ? <ThemedChevronDown size={12} /> : <ThemedChevronRight size={12} />}
          <Text style={labelStyle} numberOfLines={1}>
            {label}
          </Text>
          <Text style={stylesheet.time}>{time}</Text>
        </Pressable>
        {isWait ? null : <View style={stylesheet.line} />}
      </View>
      {expanded ? (
        <View style={stylesheet.body} dataSet={CODE_SURFACE_DATASET}>
          <Text style={stylesheet.bodyText} selectable testID="system-notification-body">
            {notification.body}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function resolveLabelStyle(summary: SystemNotificationSummary) {
  if (summary.kind !== "wait") return stylesheet.label;
  return summary.outcome === "timed_out" ? stylesheet.waitLabelTimedOut : stylesheet.waitLabel;
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[2],
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  label: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
  waitContainer: {
    paddingVertical: theme.spacing[1],
  },
  waitLabel: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: 13,
    color: theme.colors.statusDotRunning,
  },
  waitLabelTimedOut: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: 13,
    color: theme.colors.statusWarning,
  },
  time: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  body: {
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  bodyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.code,
    fontFamily: theme.fontFamily.mono,
    lineHeight: 16,
  },
}));
