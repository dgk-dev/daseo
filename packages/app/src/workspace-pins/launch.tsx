import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SquareTerminal } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { resolveTerminalProfiles } from "@getpaseo/protocol/terminal-profiles";
import { getProviderIcon } from "@/components/provider-icons";
import { getIsElectron } from "@/constants/platform";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { Theme } from "@/styles/theme";
import {
  isPinnedTargetAvailable,
  pinnedTargetKey,
  type PinnedTabTarget,
} from "@/workspace-pins/target";
import { usePinnedTargetsStore } from "@/workspace-pins/store";
import { useSessionStore } from "@/stores/session-store";

export interface ResolvedPin {
  key: string;
  label: string;
  onPress: () => void;
}

interface UsePinnedLaunchersInput {
  serverId: string;
  onLaunch: (target: PinnedTabTarget) => void;
}

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedSquareTerminal = withUnistyles(SquareTerminal);

function ProviderPinIcon({
  iconKey,
  size,
  color = "",
}: {
  iconKey: string;
  size: number;
  color?: string;
}) {
  const Icon = getProviderIcon(iconKey);
  return <Icon size={size} color={color} />;
}

const ThemedProviderPinIcon = withUnistyles(ProviderPinIcon);

export function ProfileIcon({ iconKey }: { iconKey: string | undefined }): ReactElement {
  if (!iconKey) {
    return <ThemedSquareTerminal size={14} uniProps={mutedColorMapping} />;
  }
  return <ThemedProviderPinIcon iconKey={iconKey} size={14} uniProps={mutedColorMapping} />;
}

export function usePinnedLaunchers({ serverId, onLaunch }: UsePinnedLaunchersInput): ResolvedPin[] {
  const { t } = useTranslation();
  const pinned = usePinnedTargetsStore((state) => state.pinned);
  const { config } = useDaemonConfig(serverId);
  const supportsRemoteBrowser = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.browserRemoteStream === true,
  );
  const profiles = useMemo(
    () => resolveTerminalProfiles(config?.terminalProfiles),
    [config?.terminalProfiles],
  );

  return useMemo(() => {
    const resolved: ResolvedPin[] = [];
    for (const target of pinned) {
      if (
        !isPinnedTargetAvailable(target, { isElectron: getIsElectron(), supportsRemoteBrowser })
      ) {
        continue;
      }
      if (target.kind === "draft") {
        resolved.push({
          key: pinnedTargetKey(target),
          label: t("workspace.tabs.actions.newAgent"),
          onPress: () => onLaunch(target),
        });
        continue;
      }
      if (target.kind === "terminal") {
        resolved.push({
          key: pinnedTargetKey(target),
          label: t("workspace.tabs.actions.newTerminal"),
          onPress: () => onLaunch(target),
        });
        continue;
      }
      if (target.kind === "browser") {
        resolved.push({
          key: pinnedTargetKey(target),
          label: t("workspace.tabs.actions.newBrowser"),
          onPress: () => onLaunch(target),
        });
        continue;
      }
      const profile = profiles.find((entry) => entry.id === target.profileId);
      if (!profile) {
        continue;
      }
      resolved.push({
        key: pinnedTargetKey(target),
        label: profile.name,
        onPress: () => onLaunch(target),
      });
    }
    return resolved;
  }, [onLaunch, pinned, profiles, supportsRemoteBrowser, t]);
}
