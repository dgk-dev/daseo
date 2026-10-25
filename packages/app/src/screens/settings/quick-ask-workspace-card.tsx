import { useCallback, useMemo } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as IntentLauncher from "expo-intent-launcher";
import { ChevronDown } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppSettings } from "@/hooks/use-settings";
import { listHomeWorkspaces } from "@/navigation/quick-ask";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// Android's assistant picker. ROLE_ASSISTANT is not requestable by apps, so the owner picks
// Daseo there (Samsung also routes the side button's long press through this choice).
const VOICE_INPUT_SETTINGS_ACTION = "android.settings.VOICE_INPUT_SETTINGS";

function triggerStyle({ pressed }: PressableStateCallbackType) {
  return pressed ? [styles.trigger, styles.triggerPressed] : styles.trigger;
}

function workspaceLabel(workspace: WorkspaceDescriptor): string {
  return workspace.title?.trim() || workspace.name;
}

function WorkspaceMenuItem({
  workspace,
  selected,
  onSelect,
}: {
  workspace: WorkspaceDescriptor;
  selected: boolean;
  onSelect: (workspaceId: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(workspace.id), [onSelect, workspace.id]);
  return (
    <DropdownMenuItem
      selected={selected}
      description={shortenPath(workspace.workspaceDirectory)}
      onSelect={handleSelect}
    >
      {workspaceLabel(workspace)}
    </DropdownMenuItem>
  );
}

/** Daseo delta 64: where this host's side-button quick ask opens its new agent. */
export function QuickAskWorkspaceCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const workspacesMap = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const agentsMap = useSessionStore((state) => state.sessions[serverId]?.agents);
  const workspaces = useMemo(
    () =>
      Array.from(workspacesMap?.values() ?? [])
        .filter((workspace) => !workspace.archivingAt)
        .sort((left, right) => workspaceLabel(left).localeCompare(workspaceLabel(right))),
    [workspacesMap],
  );
  const automaticWorkspace = useMemo(
    () => listHomeWorkspaces({ workspaces, agents: agentsMap?.values() ?? [] })[0] ?? null,
    [agentsMap, workspaces],
  );
  const configuredId = settings.quickAskWorkspaces[serverId] ?? null;
  const configured = workspaces.find((workspace) => workspace.id === configuredId) ?? null;

  let value = t("settings.host.workspaces.quickAsk.automaticNew");
  if (configured) {
    value = workspaceLabel(configured);
  } else if (automaticWorkspace) {
    value = t("settings.host.workspaces.quickAsk.automaticWithName", {
      name: workspaceLabel(automaticWorkspace),
    });
  }

  const select = useCallback(
    (workspaceId: string | null) => {
      const next = { ...settings.quickAskWorkspaces };
      if (workspaceId) {
        next[serverId] = workspaceId;
      } else {
        delete next[serverId];
      }
      void updateSettings({ quickAskWorkspaces: next });
    },
    [serverId, settings.quickAskWorkspaces, updateSettings],
  );
  const selectAutomatic = useCallback(() => select(null), [select]);
  const openAssistantSettings = useCallback(() => {
    void IntentLauncher.startActivityAsync(VOICE_INPUT_SETTINGS_ACTION).catch((error) => {
      console.warn("[QuickAsk] Could not open assistant settings", error);
    });
  }, []);

  return (
    <View style={settingsStyles.card} testID="host-page-quick-ask-workspace-card">
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.workspaces.quickAsk.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.workspaces.quickAsk.hint")}</Text>
        </View>
        <DropdownMenu>
          <DropdownMenuTrigger
            style={triggerStyle}
            accessibilityRole="button"
            accessibilityLabel={t("settings.host.workspaces.quickAsk.accessibilityLabel", {
              value,
            })}
            testID="host-page-quick-ask-workspace-trigger"
          >
            <Text style={styles.triggerText} numberOfLines={1}>
              {value}
            </Text>
            <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" width={280}>
            <DropdownMenuItem selected={!configured} onSelect={selectAutomatic}>
              {t("settings.host.workspaces.quickAsk.automatic")}
            </DropdownMenuItem>
            {workspaces.map((workspace) => (
              <WorkspaceMenuItem
                key={workspace.id}
                workspace={workspace}
                selected={workspace.id === configured?.id}
                onSelect={select}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.workspaces.quickAsk.assistantHint")}
          </Text>
        </View>
        <Button size="sm" variant="outline" onPress={openAssistantSettings}>
          {t("settings.host.workspaces.quickAsk.openAssistantSettings")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 200,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: {
    opacity: 0.85,
  },
  triggerText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
