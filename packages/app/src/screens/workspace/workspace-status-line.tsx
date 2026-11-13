import { Fragment, memo, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { isWeb } from "@/constants/platform";
import { useSessionStore } from "@/stores/session-store";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { formatMessageTimestamp } from "@/utils/time";

interface WorkspaceStatusLineProps {
  /** False on compact layouts, which have no room for a status bar. */
  visible: boolean;
  serverId: string;
  workspaceId: string;
  workspaceTitle: string;
  branchName: string | null;
  activeTab: WorkspaceTabDescriptor | null;
}

interface StatusLineAgentFacts {
  hostname: string | null;
  model: string | null;
  runningCount: number;
}

function statusLineAgentFactsEqual(a: StatusLineAgentFacts, b: StatusLineAgentFacts): boolean {
  return a.hostname === b.hostname && a.model === b.model && a.runningCount === b.runningCount;
}

// "pi/pi-codex/gpt-6-luna" reads as "gpt-6-luna": the provider path is in the tab already.
function shortModelId(model: string): string {
  const separatorIndex = model.lastIndexOf("/");
  return separatorIndex === -1 ? model : model.slice(separatorIndex + 1);
}

/**
 * The time at the far right, re-rendered once a minute by itself; nothing else in the status
 * line ticks.
 */
const StatusLineClock = memo(function StatusLineClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const msToNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    const handle = setTimeout(() => setNow(new Date()), msToNextMinute);
    return () => clearTimeout(handle);
  }, [now]);
  return (
    <Text style={styles.text} numberOfLines={1} testID="workspace-status-line-clock">
      {formatMessageTimestamp(now, now)}
    </Text>
  );
});

function StatusLineSeparator() {
  return <Text style={styles.separator}>│</Text>;
}

/**
 * Daseo delta 51: a one-line status bar under the desktop workspace, as an editor or a
 * terminal multiplexer prints one: host · workspace · branch · model of the active agent
 * · agents running in this workspace. Machine facts only, in the mono face; nothing here
 * is interactive, so it never competes with the composer above it.
 *
 * Daseo delta 89: tmux's grammar — the host is an inverse block in the accent, segments are
 * split by `│` in the border colour, and the clock closes the line on the right.
 */
export const WorkspaceStatusLine = memo(function WorkspaceStatusLine({
  visible,
  serverId,
  workspaceId,
  workspaceTitle,
  branchName,
  activeTab,
}: WorkspaceStatusLineProps) {
  const { t } = useTranslation();
  const activeAgentId = activeTab?.target.kind === "agent" ? activeTab.target.agentId : null;
  const facts = useStoreWithEqualityFn(
    useSessionStore,
    (state): StatusLineAgentFacts => {
      const session = state.sessions[serverId];
      let runningCount = 0;
      for (const agent of session?.agents.values() ?? []) {
        if (agent.workspaceId === workspaceId && agent.status === "running" && !agent.archivedAt) {
          runningCount += 1;
        }
      }
      const activeModel = activeAgentId ? session?.agents.get(activeAgentId)?.model : null;
      return {
        hostname: session?.serverInfo?.hostname ?? null,
        model: activeModel ? shortModelId(activeModel) : null,
        runningCount,
      };
    },
    statusLineAgentFactsEqual,
  );

  // Web and desktop app only: on the unfolded Fold the bar sat under the composer as a footer the
  // owner did not want (2026-11-14).
  if (!visible || !isWeb) {
    return null;
  }

  const segments = [
    { id: "workspace", text: workspaceTitle || null },
    { id: "branch", text: branchName },
    { id: "model", text: facts.model },
  ].filter((segment): segment is { id: string; text: string } => Boolean(segment.text));

  return (
    <View style={styles.bar} dataSet={CODE_SURFACE_DATASET} testID="workspace-status-line">
      <View style={styles.segments}>
        {facts.hostname ? (
          <View style={styles.hostSegment}>
            <Text style={styles.hostText} numberOfLines={1}>
              {facts.hostname}
            </Text>
          </View>
        ) : null}
        {segments.map((segment, index) => (
          <Fragment key={segment.id}>
            {index > 0 || facts.hostname ? <StatusLineSeparator /> : null}
            <Text style={styles.text} numberOfLines={1}>
              {segment.text}
            </Text>
          </Fragment>
        ))}
      </View>
      <View style={styles.trailing}>
        {facts.runningCount > 0 ? (
          <View style={styles.running}>
            <View style={styles.runningDot} />
            <Text style={styles.runningText} numberOfLines={1}>
              {t("workspace.statusLine.running", { count: facts.runningCount })}
            </Text>
          </View>
        ) : null}
        {facts.runningCount > 0 ? <StatusLineSeparator /> : null}
        <StatusLineClock />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    minHeight: 24,
    paddingRight: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  segments: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    flexShrink: 1,
    overflow: "hidden",
  },
  // Inverse video: the accent block that tells a glance which machine this is.
  hostSegment: {
    alignSelf: "stretch",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.accent,
    flexShrink: 0,
  },
  hostText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.accentForeground,
  },
  separator: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.border,
    flexShrink: 0,
  },
  text: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  runningText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.success,
  },
  running: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  runningDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.success,
  },
}));
