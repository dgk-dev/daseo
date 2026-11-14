import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Import as ImportIcon } from "lucide-react-native";
import { Button } from "@/components/ui/button";

interface ComposerImportPillProps {
  onPress: () => void;
  disabled?: boolean;
}

// Daseo delta 116: the draft's import action is the app Button, so it prints as the muted bracket
// text `[ Import session ]` with its icon, like every other labelled button (it was a bordered pill).
export function ComposerImportPill({ onPress, disabled = false }: ComposerImportPillProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.row}>
      <Button
        variant="outline"
        size="sm"
        leftIcon={ImportIcon}
        testID="composer-import-agent-pill"
        accessibilityLabel={t("importSession.title")}
        onPress={onPress}
        disabled={disabled}
      >
        {t("importSession.title")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  row: {
    flexDirection: "row",
  },
}));
