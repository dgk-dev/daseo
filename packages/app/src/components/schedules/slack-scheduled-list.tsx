import { CalendarClock, MessageSquare } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  formatSlackPostTime,
  partitionSlackScheduled,
  slackEntryLink,
  slackSenderLabel,
  slackStatusBadge,
  type AggregatedSlackScheduled,
  type SlackScheduledFetchResult,
} from "@/schedules/slack-scheduled";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { openSlackMessage } from "@/utils/open-slack-message";
import { formatNextRun } from "@/utils/schedule-format";
import { formatTimeAgo } from "@/utils/time";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const LEADING_ICON_SIZE = 16;

interface SlackScheduledListProps {
  data: SlackScheduledFetchResult | undefined;
  isLoading: boolean;
  isError: boolean;
  /** Host filter of the screen: a server id, or null for every host. */
  serverId: string | null;
  singleHost: boolean;
  onRetry: () => void;
}

/**
 * Daseo delta 135: the Schedules screen's Slack filter. Read-only by decision: no cancel,
 * reschedule, or send-now, so the rule that only messages David-Daniel approved in chat are sent
 * stays inside the chat. Rows reuse the schedule row's card, spacing, badge, and hover.
 */
export function SlackScheduledList({
  data,
  isLoading,
  isError,
  serverId,
  singleHost,
  onRetry,
}: SlackScheduledListProps): ReactElement {
  if (isLoading && !data) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }
  if (isError && !data) {
    return (
      <View style={styles.centered} testID="slack-scheduled-error">
        <Text style={styles.message}>Unable to load scheduled Slack messages</Text>
        <Button variant="ghost" onPress={onRetry} testID="slack-scheduled-retry">
          Try again
        </Button>
      </View>
    );
  }

  const entries = (data?.entries ?? []).filter(
    (entry) => serverId === null || entry.serverId === serverId,
  );
  const { upcoming, past } = partitionSlackScheduled(entries, Date.now());
  const notices = [
    ...(data?.hostErrors ?? []).map((error) => ({
      key: `error:${error.serverId}`,
      text: `${error.serverName}: Could not load scheduled Slack messages`,
      isError: true,
    })),
    ...(data?.warnings ?? []).map((warning, index) => ({
      key: `warning:${index}`,
      text: warning,
      isError: false,
    })),
  ];

  return (
    <View style={styles.listContent} testID="slack-scheduled-list">
      {notices.length > 0 ? (
        <View style={styles.noticeBanner} testID="slack-scheduled-notices">
          {notices.map((notice) => (
            <Text
              key={notice.key}
              style={notice.isError ? styles.noticeError : styles.noticeText}
              numberOfLines={2}
            >
              {notice.text}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={settingsStyles.section}>
        <View style={settingsStyles.sectionHeader}>
          <Text style={settingsStyles.sectionHeaderTitle}>예정</Text>
        </View>
        {upcoming.length > 0 ? (
          <SlackScheduledCard entries={upcoming} singleHost={singleHost} />
        ) : (
          <View style={styles.emptyState} testID="slack-scheduled-empty">
            <CalendarClock size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
            <Text style={styles.emptyTitle}>예약된 슬랙 메시지가 없습니다</Text>
            <Text style={styles.emptyDescription}>
              슬랙 앱에서 직접 건 예약은 여기 나오지 않습니다
            </Text>
          </View>
        )}
      </View>
      {past.length > 0 ? (
        <View style={settingsStyles.section}>
          <View style={settingsStyles.sectionHeader}>
            <Text style={settingsStyles.sectionHeaderTitle}>지난 30일</Text>
          </View>
          <SlackScheduledCard entries={past} singleHost={singleHost} />
        </View>
      ) : null}
    </View>
  );
}

function SlackScheduledCard({
  entries,
  singleHost,
}: {
  entries: AggregatedSlackScheduled[];
  singleHost: boolean;
}): ReactElement {
  return (
    <View style={settingsStyles.card}>
      {entries.map((entry, index) => (
        <SlackScheduledRow
          key={entry.id}
          entry={entry}
          isFirst={index === 0}
          singleHost={singleHost}
        />
      ))}
    </View>
  );
}

function buildMeta(entry: AggregatedSlackScheduled, singleHost: boolean): string {
  const iso = new Date(entry.postAt * 1000).toISOString();
  const relative = entry.status === "scheduled" ? formatNextRun(iso) : formatTimeAgo(new Date(iso));
  const parts = [slackSenderLabel(entry.as), `${formatSlackPostTime(entry.postAt)} · ${relative}`];
  if (!singleHost) {
    parts.unshift(entry.serverName);
  }
  return parts.join(" · ");
}

export function SlackScheduledRow({
  entry,
  isFirst,
  singleHost,
}: {
  entry: AggregatedSlackScheduled;
  isFirst: boolean;
  singleHost: boolean;
}): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const link = useMemo(() => slackEntryLink(entry), [entry]);
  const badge = slackStatusBadge(entry.status);

  const handlePress = useCallback(() => {
    if (link) void openSlackMessage(link);
  }, [link]);

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      link !== null && isHovered && !isCompact && styles.rowHovered,
      link !== null && pressed && styles.rowPressed,
    ],
    [isFirst, isHovered, isCompact, link],
  );

  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={link ? handlePress : undefined}
        disabled={link === null}
        accessibilityRole={link ? "link" : undefined}
        testID={`slack-scheduled-row-${entry.id}`}
      >
        <View style={styles.main}>
          <View style={styles.leading}>
            <ThemedMessageSquare size={LEADING_ICON_SIZE} uniProps={mutedColorMapping} />
          </View>
          <View style={styles.textGroup}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {entry.firstLine || "(내용 없음)"}
            </Text>
            <Text style={styles.target} numberOfLines={1}>
              {entry.toLabel}
            </Text>
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              {buildMeta(entry, singleHost)}
            </Text>
            {entry.status === "failed" && entry.error ? (
              <Text style={settingsStyles.rowError} numberOfLines={1}>
                {entry.error}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={styles.trailing}>
          <StatusBadge label={badge.label} variant={badge.variant} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Same list padding as SchedulesTable.
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  centered: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  noticeBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
    marginBottom: theme.spacing[3],
  },
  noticeError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  noticeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[6],
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  // Row parts match ScheduleRow.
  rowContainer: {
    position: "relative",
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  leading: {
    width: LEADING_ICON_SIZE,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  target: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
