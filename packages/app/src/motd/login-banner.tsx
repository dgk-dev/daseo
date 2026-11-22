import { Fragment, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { resolveAppVersion } from "@/utils/app-version";
import { buildLoginBanner, layoutLoginBanner } from "./format";
import { useLoginBannerFacts } from "./use-login-banner";

/**
 * Daseo: the Ubuntu-style login banner at the top left of a chat that has no message yet. Muted
 * text, selectable, no box; it leaves with the first message because its parents render it only
 * while the chat is empty. Notes and the restart line are coloured spans inside the one Text, so
 * the banner stays a single selectable block (delta 144).
 */
export function LoginBanner({ serverId }: { serverId: string | null | undefined }): ReactElement {
  const facts = useLoginBannerFacts(serverId);
  const isCompact = useIsCompactFormFactor();
  const lines = useMemo(
    () =>
      layoutLoginBanner(
        buildLoginBanner({ appVersion: resolveAppVersion(), facts }),
        isCompact ? 1 : 2,
      ),
    [facts, isCompact],
  );
  return (
    <View style={styles.container} testID="login-banner">
      <Text style={styles.text} selectable>
        {lines.map((line, index) => (
          <Fragment key={line.key}>
            {index > 0 ? "\n" : null}
            {line.tone === "muted" ? (
              line.text
            ) : (
              <Text style={line.tone === "critical" ? styles.critical : styles.bright}>
                {line.text}
              </Text>
            )}
          </Fragment>
        ))}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A warning note and the restart line: one step brighter than the muted banner.
  bright: {
    color: theme.colors.foreground,
  },
  // A critical note: the red a failed `exit N` uses on tool rows.
  critical: {
    color: theme.colors.destructive,
  },
  container: {
    alignSelf: "stretch",
    alignItems: "flex-start",
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
    userSelect: "text",
  },
}));
