import { StyleSheet, View } from "react-native";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";

export default function EmptyWorkspaceRoute() {
  return (
    <View style={styles.container} testID="empty-workspace-route">
      <TitlebarDragRegion />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
