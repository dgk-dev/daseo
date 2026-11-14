import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatIdentity, type ShellPromptParts } from "./shell-prompt";

interface ShellPromptSpansProps {
  parts: ShellPromptParts;
  /** Phone and folded layouts keep only `path$`. */
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
  return (
    <Text selectable={false} aria-hidden>
      {identity ? <Text style={styles.identity}>{identity}</Text> : null}
      {identity && parts.path ? ":" : null}
      {parts.path ? <Text style={styles.path}>{parts.path}</Text> : null}
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
