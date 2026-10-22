import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

interface DiffStatProps {
  additions: number;
  deletions: number;
  testID?: string;
}

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatDiffCount(value: number): string {
  return compactFormatter.format(value).toLowerCase();
}

export function DiffStat({ additions, deletions, testID }: DiffStatProps) {
  return (
    <View style={styles.row} dataSet={CODE_SURFACE_DATASET} testID={testID}>
      <Text style={styles.additions}>+{formatDiffCount(additions)}</Text>
      <Text style={styles.deletions}>-{formatDiffCount(deletions)}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: 20,
    gap: 4,
    flexShrink: 0,
  },
  // Daseo delta 51: counts are machine text, set in the mono face.
  additions: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusSuccess,
  },
  deletions: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusDanger,
  },
}));
