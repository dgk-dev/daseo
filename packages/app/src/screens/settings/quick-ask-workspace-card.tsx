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
import { listHomeProjects } from "@/navigation/quick-ask";
import { useSessionStore, type ProjectDescriptor } from "@/stores/session-store";
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

function projectLabel(project: ProjectDescriptor): string {
  return project.projectCustomName?.trim() || project.projectDisplayName;
}

function ProjectMenuItem({
  project,
  selected,
  onSelect,
}: {
  project: ProjectDescriptor;
  selected: boolean;
  onSelect: (projectId: string) => void;
}) {
  const handleSelect = useCallback(
    () => onSelect(project.projectId),
    [onSelect, project.projectId],
  );
  return (
    <DropdownMenuItem
      selected={selected}
      description={shortenPath(project.projectRootPath)}
      onSelect={handleSelect}
    >
      {projectLabel(project)}
    </DropdownMenuItem>
  );
}

/** Daseo delta 64: the project this host's side-button quick ask creates a new workspace in. */
export function QuickAskWorkspaceCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const projectsMap = useSessionStore((state) => state.sessions[serverId]?.projects);
  const projects = useMemo(
    () =>
      Array.from(projectsMap?.values() ?? []).sort((left, right) =>
        projectLabel(left).localeCompare(projectLabel(right)),
      ),
    [projectsMap],
  );
  const automaticProject = useMemo(() => listHomeProjects(projects)[0] ?? null, [projects]);
  const configuredId = settings.quickAskProjects[serverId] ?? null;
  const configured = projects.find((project) => project.projectId === configuredId) ?? null;

  let value = t("settings.host.workspaces.quickAsk.automaticNew");
  if (configured) {
    value = projectLabel(configured);
  } else if (automaticProject) {
    value = t("settings.host.workspaces.quickAsk.automaticWithName", {
      name: projectLabel(automaticProject),
    });
  }

  const select = useCallback(
    (projectId: string | null) => {
      const next = { ...settings.quickAskProjects };
      if (projectId) {
        next[serverId] = projectId;
      } else {
        delete next[serverId];
      }
      void updateSettings({ quickAskProjects: next });
    },
    [serverId, settings.quickAskProjects, updateSettings],
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
            {projects.map((project) => (
              <ProjectMenuItem
                key={project.projectId}
                project={project}
                selected={project.projectId === configured?.projectId}
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
