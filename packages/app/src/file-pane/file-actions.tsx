import { useCallback } from "react";
import * as Clipboard from "expo-clipboard";
import { Ellipsis, ExternalLink, Link, Share2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useOpenFileExternally } from "@/assistant-file-links/use-open-file-externally";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";

// Daseo delta 75: on the phone a text or image file opens in this pane instead of another app,
// so the pane offers the ways out: the Android "open with" intent (the delta 62 path), the share
// sheet, and a tailnet https link that opens in Chrome or a messenger. Web and the Mac app have
// their own openers; `file-actions.web.tsx` renders nothing there.

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedShare = withUnistyles(Share2);
const ThemedLink = withUnistyles(Link);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const OPEN_ICON = <ThemedExternalLink size={16} uniProps={mutedColorMapping} />;
const SHARE_ICON = <ThemedShare size={16} uniProps={mutedColorMapping} />;
const LINK_ICON = <ThemedLink size={16} uniProps={mutedColorMapping} />;
const TRIGGER_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

function TriggerIcon({ open }: { hovered: boolean; open: boolean }) {
  return <ThemedEllipsis size={16} uniProps={open ? foregroundColorMapping : mutedColorMapping} />;
}

export function FileActions({
  serverId,
  cwd,
  path,
}: {
  serverId: string;
  /** The read target's directory; a relative `path` resolves against it. */
  cwd: string;
  path: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const openFileExternally = useOpenFileExternally({ serverId });
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supportsPreviewLinks = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.previewLinks === true,
  );
  const filePath = joinReadTarget(cwd, path);

  const handOff = useCallback(
    async (handoff: "open" | "share") => {
      const started = await openFileExternally?.({ raw: filePath, path: filePath }, handoff);
      if (!started) {
        toast.error(t("panels.file.actions.openFailed"));
      }
    },
    [filePath, openFileExternally, t, toast],
  );
  const handleOpenElsewhere = useCallback(() => void handOff("open"), [handOff]);
  const handleShare = useCallback(() => void handOff("share"), [handOff]);
  const handleCopyLink = useCallback(() => {
    void (async () => {
      if (!client) {
        toast.error(t("workspace.terminal.hostDisconnected"));
        return;
      }
      try {
        const result = await client.createPreviewLink({ path: filePath });
        if (!result.url) {
          toast.error(
            t("panels.file.actions.linkFailed", { message: result.error?.message ?? "" }),
          );
          return;
        }
        await Clipboard.setStringAsync(result.url);
        toast.copied(t("panels.file.actions.linkCopiedLabel"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(t("panels.file.actions.linkFailed", { message }));
      }
    })();
  }, [client, filePath, t, toast]);

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        testID="file-pane-actions-trigger"
        style={styles.trigger}
        hitSlop={TRIGGER_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t("panels.file.actions.menu")}
      >
        {TriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={220}
        testID="file-pane-actions-menu"
        sheetTitle={t("panels.file.actions.menu")}
      >
        <DropdownMenuItem
          testID="file-pane-open-elsewhere"
          leading={OPEN_ICON}
          onSelect={handleOpenElsewhere}
        >
          {t("panels.file.actions.openElsewhere")}
        </DropdownMenuItem>
        <DropdownMenuItem testID="file-pane-share" leading={SHARE_ICON} onSelect={handleShare}>
          {t("panels.file.actions.share")}
        </DropdownMenuItem>
        {supportsPreviewLinks ? (
          <DropdownMenuItem
            testID="file-pane-copy-link"
            leading={LINK_ICON}
            onSelect={handleCopyLink}
          >
            {t("panels.file.actions.copyLink")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function joinReadTarget(cwd: string, path: string): string {
  if (
    path.startsWith("/") ||
    path === "~" ||
    path.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    return path;
  }
  return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: theme.spacing[6],
    height: theme.spacing[6],
    marginRight: -theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
}));
