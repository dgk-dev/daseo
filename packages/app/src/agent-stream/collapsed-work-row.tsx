import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/time";
import { useCollapsedWork } from "./collapsed-work-context";

const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevronRight = withUnistyles(ChevronRight, chevronColorMapping);
const ThemedChevronDown = withUnistyles(ChevronDown, chevronColorMapping);

const HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 } as const;

/**
 * Codex-style summary of a completed turn's collapsed activity, rendered right
 * above the turn's final assistant message. The row itself toggles the hidden
 * work items back into the transcript.
 */
export const CollapsedWorkRow = memo(function CollapsedWorkRow({ turnKey }: { turnKey: string }) {
  const controller = useCollapsedWork();
  const workCount = controller?.getWorkCount(turnKey) ?? 0;
  const expanded = controller?.isExpanded(turnKey) ?? false;
  const durationMs = controller?.getDurationMs(turnKey);
  const handlePress = useCallback(() => {
    controller?.toggle(turnKey);
  }, [controller, turnKey]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  if (!controller || workCount === 0) {
    return null;
  }

  const label =
    durationMs !== undefined
      ? `Worked for ${formatDuration(durationMs)}`
      : `${workCount} ${workCount === 1 ? "step" : "steps"}`;

  return (
    <View style={stylesheet.row}>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={
          expanded ? `${label}, hide work details` : `${label}, show work details`
        }
        testID="collapsed-work-row"
        style={stylesheet.pressable}
        hitSlop={HIT_SLOP}
      >
        {expanded ? <ThemedChevronDown size={14} /> : <ThemedChevronRight size={14} />}
        <Text style={stylesheet.label}>{label}</Text>
      </Pressable>
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    marginBottom: theme.spacing[3],
  },
  pressable: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
