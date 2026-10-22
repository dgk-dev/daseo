import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "@/stores/session-store";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

interface WorkspaceStatusLineProps {
  /** Desktop only: compact layouts have no room for a status bar. */
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
 * Daseo delta 51: a one-line status bar under the desktop workspace, as an editor or a
 * terminal multiplexer prints one: host · workspace · branch · model of the active agent
 * · agents running in this workspace. Machine facts only, in the mono face; nothing here
 * is interactive, so it never competes with the composer above it.
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

  if (!visible) {
    return null;
  }

  const segments = [facts.hostname, workspaceTitle || null, branchName, facts.model].filter(
    (segment): segment is string => Boolean(segment),
  );

  return (
    <View style={styles.bar} dataSet={CODE_SURFACE_DATASET} testID="workspace-status-line">
      <Text style={styles.text} numberOfLines={1}>
        {segments.join("  ·  ")}
      </Text>
      {facts.runningCount > 0 ? (
        <View style={styles.running}>
          <View style={styles.runningDot} />
          <Text style={styles.text} numberOfLines={1}>
            {t("workspace.statusLine.running", { count: facts.runningCount })}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    minHeight: 24,
    paddingHorizontal: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceWorkspace,
  },
  text: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
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
