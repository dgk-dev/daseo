import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatIdentity, shortPromptPath, type ShellPromptParts } from "./shell-prompt";

interface ShellPromptSpansProps {
  parts: ShellPromptParts;
  /** Only the last folder and `$` (`office$`); every layout uses it since 2026-11-15. */
  compact: boolean;
  /** A sent prompt runs straight into its text, so it carries bash's space after `$`. */
  trailingSpace?: boolean;
}

/**
 * Ubuntu's PS1 as inline spans: bold accent `user@host`, plain `:`, bold blue path, plain `$`.
 * The plain parts take the surrounding text style, so render this inside a `Text`. It is not
 * selectable: copying a prompt copies what was typed, not the prompt.
 */
export function ShellPromptSpans({ parts, compact, trailingSpace = false }: ShellPromptSpansProps) {
  const identity = compact ? "" : formatIdentity(parts);
  const path = parts.path && compact ? shortPromptPath(parts.path) : parts.path;
  return (
    <Text selectable={false} aria-hidden>
      {identity ? <Text style={styles.identity}>{identity}</Text> : null}
      {identity && path ? ":" : null}
      {path ? <Text style={styles.path}>{path}</Text> : null}
      {trailingSpace ? "$ " : "$"}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  identity: {
    color: theme.colors.accent,
    fontWeight: theme.fontWeight.bold,
  },
  path: {
    color: theme.colors.promptPath,
    fontWeight: theme.fontWeight.bold,
  },
}));
