import { forwardRef, useCallback, type ComponentProps } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import type { AgentControlIcon } from "@/agent-controls/icons";
import {
  HINT_LINE_HIT_SLOP,
  HintCaret,
  HintValue,
  HintWord,
  hintLineStyles,
} from "@/composer/hint-line";

type AgentControlTriggerProps = Omit<
  ComponentProps<typeof ComboboxTrigger>,
  "accessibilityLabel" | "block" | "children" | "chevron" | "onPress" | "style"
> & {
  icon: AgentControlIcon;
  iconColor?: string;
  surface: "toolbar" | "sheet";
  label: string;
  /** Daseo delta 89: the command word on the composer hint line; defaults to `label`, lowercased. */
  hintLabel?: string;
  value?: string;
  showToolbarLabel?: boolean;
  showCaret?: boolean;
  open?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
};

export const AgentControlTrigger = forwardRef<View, AgentControlTriggerProps>(
  function AgentControlTrigger(
    {
      icon: Icon,
      iconColor,
      surface,
      label,
      hintLabel,
      value,
      showToolbarLabel = true,
      showCaret = false,
      open = false,
      disabled = false,
      onPress,
      accessibilityLabel,
      testID,
      ...triggerProps
    },
    ref,
  ) {
    const { glyphSize } = useComposerControlLayout();
    const isSheet = surface === "sheet";
    const resolvedGlyphSize = isSheet ? 16 : glyphSize;
    const resolvedIconColor = iconColor ?? styles.iconColor.color;
    const triggerStyle = useCallback(
      ({ pressed, hovered }: PressableStateCallbackType) =>
        isSheet
          ? [
              styles.sheetRow,
              (hovered || pressed || open) && styles.sheetRowInteractive,
              disabled && styles.disabled,
            ]
          : [hintLineStyles.control, disabled && hintLineStyles.controlDisabled],
      [disabled, isSheet, open],
    );

    if (!isSheet) {
      // Daseo delta 89: on the composer hint line a control is `word value ▾` in text; a toggle
      // is its word, in the accent while it is on. The icon, pill, and fill are gone.
      const checked = triggerProps.accessibilityState?.checked === true;
      const word = hintLabel ?? label.toLowerCase();
      return (
        <ComboboxTrigger
          hitSlop={HINT_LINE_HIT_SLOP}
          {...triggerProps}
          ref={ref}
          collapsable={false}
          disabled={disabled}
          onPress={onPress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          chevron={null}
        >
          {({ hovered, pressed }: { hovered: boolean; pressed: boolean }) => (
            <>
              {checked ? (
                <HintValue>{word}</HintValue>
              ) : (
                <HintWord active={hovered || pressed || open}>{word}</HintWord>
              )}
              {value !== undefined && showToolbarLabel ? <HintValue>{value}</HintValue> : null}
              {value !== undefined && (showCaret || !showToolbarLabel) ? <HintCaret /> : null}
            </>
          )}
        </ComboboxTrigger>
      );
    }

    return (
      <ComboboxTrigger
        {...triggerProps}
        ref={ref}
        collapsable={false}
        disabled={disabled}
        onPress={onPress}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        chevron={showCaret ? undefined : null}
      >
        <View style={styles.sheetGlyph}>
          <Icon size={resolvedGlyphSize} color={resolvedIconColor} />
        </View>
        <Text style={styles.sheetLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.sheetValue} numberOfLines={1}>
          {value ?? label}
        </Text>
      </ComboboxTrigger>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  sheetRow: {
    minHeight: 44,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: -theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: theme.colors.surface1,
  },
  sheetRowInteractive: {
    backgroundColor: theme.colors.surface2,
  },
  sheetGlyph: {
    width: 20,
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  sheetValue: {
    maxWidth: "45%",
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  disabled: {
    opacity: 0.5,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
}));
