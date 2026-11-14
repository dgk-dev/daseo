import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCallback, useMemo } from "react";
import { View, Pressable, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MoreVertical } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { ShortcutKey } from "@/utils/format-shortcut";
import type { GitAction, GitActionId, GitActions } from "@/git/policy";
import { HEADER_WORDS, HeaderWord } from "@/screens/workspace/header-word";
import { useGitActionRunner } from "@/git/use-actions";

interface GitActionsSplitButtonProps {
  gitActions: GitActions;
}

// Daseo delta 116: the primary git action reads as a word, `commit ▾`, in the header word style.
// The word names the action in command vocabulary (English in every locale, like the hint line);
// the menu items, accessibility label and tooltips keep their translated labels.
const GIT_ACTION_WORDS: Record<GitActionId, string> = {
  commit: "commit",
  pull: "pull",
  push: "push",
  "pull-and-push": "sync",
  pr: "pr",
  "merge-pr-squash": "merge",
  "merge-pr-merge": "merge",
  "merge-pr-rebase": "merge",
  "enable-pr-auto-merge-squash": "auto-merge",
  "enable-pr-auto-merge-merge": "auto-merge",
  "enable-pr-auto-merge-rebase": "auto-merge",
  "disable-pr-auto-merge": "auto-merge off",
  "merge-branch": "merge",
  "merge-from-base": "update",
  "archive-workspace": "archive",
};

/** The word for the primary action; a finished action keeps its word and gains a check. */
export function resolveGitActionWord(action: GitAction): string {
  const word = GIT_ACTION_WORDS[action.id];
  return action.status === "success" ? `${word} ✓` : word;
}

interface GitActionMenuItemProps {
  action: GitAction;
  onSelect: (action: GitAction) => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  needsSeparator?: boolean;
  showSeparator?: boolean;
  closeOnSelect?: boolean;
}

function GitActionMenuItem({
  action,
  onSelect,
  archiveShortcutKeys,
  needsSeparator,
  showSeparator,
  closeOnSelect,
}: GitActionMenuItemProps) {
  const handleSelect = useCallback(() => onSelect(action), [onSelect, action]);
  const trailing = useMemo(
    () =>
      action.id === "archive-workspace" && archiveShortcutKeys ? (
        <Shortcut chord={archiveShortcutKeys} />
      ) : undefined,
    [action.id, archiveShortcutKeys],
  );
  return (
    <View>
      {needsSeparator && showSeparator ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        testID={
          action.id === "archive-workspace"
            ? "workspace-archive-action"
            : `changes-menu-${action.id}`
        }
        leading={action.icon}
        trailing={trailing}
        disabled={action.disabled}
        muted={Boolean(action.unavailableMessage)}
        status={action.status}
        pendingLabel={action.pendingLabel}
        successLabel={action.successLabel}
        closeOnSelect={closeOnSelect}
        onSelect={handleSelect}
      >
        {action.label}
      </DropdownMenuItem>
    </View>
  );
}

export function GitActionsSplitButton({ gitActions }: GitActionsSplitButtonProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const runGitAction = useGitActionRunner();
  const archiveShortcutKeys = useShortcutKeys("archive-workspace");

  const getActionDisplayLabel = useCallback((action: GitAction): string => {
    if (action.status === "pending") return action.pendingLabel;
    if (action.status === "success") return action.successLabel;
    return action.label;
  }, []);

  const handlePrimaryPress = useCallback(() => {
    if (!gitActions.primary) {
      return;
    }
    runGitAction(gitActions.primary);
  }, [gitActions.primary, runGitAction]);

  const overflowMenuButtonStyle = useMemo(() => [styles.iconButton, styles.overflowMenuButton], []);

  const primaryDisabled = gitActions.primary?.disabled;
  const primaryPressableStyle = useMemo(
    () => [styles.splitButtonPrimary, primaryDisabled && styles.splitButtonPrimaryDisabled],
    [primaryDisabled],
  );

  return (
    <View style={styles.row}>
      {gitActions.primary ? (
        <View style={styles.splitButton}>
          <Pressable
            testID="changes-primary-cta"
            style={primaryPressableStyle}
            onPress={handlePrimaryPress}
            disabled={gitActions.primary.disabled}
            accessibilityRole="button"
            accessibilityLabel={getActionDisplayLabel(gitActions.primary)}
          >
            {({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) =>
              gitActions.primary?.status === "pending" ? (
                <LoadingSpinner
                  size="small"
                  color={theme.colors.foreground}
                  style={styles.splitButtonSpinnerOnly}
                />
              ) : (
                <HeaderWord tone={hovered || pressed ? "active" : "muted"}>
                  {gitActions.primary ? resolveGitActionWord(gitActions.primary) : ""}
                </HeaderWord>
              )
            }
          </Pressable>
          {gitActions.secondary.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                testID="changes-primary-cta-caret"
                style={styles.splitButtonCaret}
                accessibilityRole="button"
                accessibilityLabel={t("workspace.git.actions.moreOptions")}
              >
                {({ hovered, pressed, open }) => (
                  <HeaderWord tone={hovered || pressed || open ? "active" : "muted"}>
                    {HEADER_WORDS.caret}
                  </HeaderWord>
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" testID="changes-primary-cta-menu">
                {gitActions.secondary.map((action, index) => (
                  <GitActionMenuItem
                    key={action.id}
                    action={action}
                    onSelect={runGitAction}
                    archiveShortcutKeys={archiveShortcutKeys}
                    needsSeparator={action.startsGroup}
                    showSeparator={index > 0}
                    closeOnSelect={
                      action.status === "idle" &&
                      action.id === "pr" &&
                      action.label === action.pendingLabel &&
                      action.label === action.successLabel
                    }
                  />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </View>
      ) : null}
      {gitActions.menu.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            testID="changes-overflow-menu"
            hitSlop={8}
            style={overflowMenuButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.git.actions.moreActions")}
          >
            <MoreVertical size={16} color={theme.colors.foregroundMuted} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={220} testID="changes-overflow-content">
            {gitActions.menu.map((action) => (
              <GitActionMenuItem
                key={action.id}
                action={action}
                onSelect={runGitAction}
                closeOnSelect={false}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  // Two words, `commit` and `▾`, each its own target; no box, border or fill (delta 116).
  splitButton: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  splitButtonPrimary: {
    minHeight: theme.spacing[8],
    paddingLeft: theme.spacing[1],
    paddingRight: theme.spacing[0.5],
    justifyContent: "center",
    position: "relative",
  },
  splitButtonPrimaryDisabled: {
    opacity: 0.6,
  },
  splitButtonSpinnerOnly: {
    transform: [{ scale: 0.8 }],
  },
  splitButtonCaret: {
    minHeight: theme.spacing[8],
    paddingLeft: theme.spacing[0.5],
    paddingRight: theme.spacing[1],
    justifyContent: "center",
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  overflowMenuButton: {
    marginRight: -theme.spacing[2],
  },
}));
