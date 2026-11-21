import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { resolveAppVersion } from "@/utils/app-version";
import { buildLoginBanner, layoutLoginBanner } from "./format";
import { useLoginBannerFacts } from "./use-login-banner";

/**
 * Daseo: the Ubuntu-style login banner at the top left of a chat that has no message yet. Plain
 * muted text, selectable, no box; it leaves with the first message because its parents render
 * it only while the chat is empty.
 */
export function LoginBanner({ serverId }: { serverId: string | null | undefined }): ReactElement {
  const facts = useLoginBannerFacts(serverId);
  const isCompact = useIsCompactFormFactor();
  const text = useMemo(
    () =>
      layoutLoginBanner(
        buildLoginBanner({ appVersion: resolveAppVersion(), facts }),
        isCompact ? 1 : 2,
      ).join("\n"),
    [facts, isCompact],
  );
  return (
    <View style={styles.container} testID="login-banner">
      <Text style={styles.text} selectable>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
