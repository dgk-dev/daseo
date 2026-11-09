import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentProfilePicker } from "@/agent-profiles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { ModelBrowser, useModelBrowser } from "@/components/model-browser";
import {
  HINT_LINE_HIT_SLOP,
  HINT_LINE_LABELS,
  HintCaret,
  HintValue,
  HintWord,
  hintLineStyles,
} from "@/composer/hint-line";
import { resolveModelSheetLayout } from "@/composer/agent-controls/model-sheet-layout";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useKeyboardVisible } from "@/hooks/use-keyboard-visible";

const SNAP_POINTS = ["80%", "90%"];
const MODEL_LIST_TOP_INSET = 4;
const MODEL_ROW_STRIDE = 44;
const MODEL_VIEWPORT_VISIBLE_ROWS = 4.5;
const FIXED_MODEL_VIEWPORT_HEIGHT =
  MODEL_LIST_TOP_INSET + MODEL_ROW_STRIDE * MODEL_VIEWPORT_VISIBLE_ROWS;

interface CompactModelSheetProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: string, modelId: string) => void;
  isLoading: boolean;
  profiles?: AgentProfilePicker | null;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  children: ReactNode;
}

function shortModelLabel(label: string): string {
  const separatorIndex = label.lastIndexOf("/");
  return separatorIndex === -1 ? label : label.slice(separatorIndex + 1);
}

export function CompactModelSheet({
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
  isLoading,
  profiles = null,
  onApplyProfile,
  onEditProfiles,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  children,
}: CompactModelSheetProps) {
  const { t } = useTranslation();
  const usesBottomSheet = useIsCompactFormFactor();
  const [isOpen, setIsOpen] = useState(false);
  const isKeyboardVisible = useKeyboardVisible(isOpen);
  const layout = resolveModelSheetLayout({
    usesBottomSheet,
    isKeyboardVisible,
    hasControls: true,
  });
  const browser = useModelBrowser({
    providers,
    selectedProvider,
    selectedModel,
    isLoading,
    profiles,
    serverId,
  });
  const { prepareToOpen, reset } = browser;
  const compactFooter = useMemo(
    () =>
      layout.showControlsFooter ? (
        <View style={styles.compactFooter} testID="agent-controls-settings-list">
          <View style={styles.modelViewportDivider} />
          <View style={[styles.controlsContent, styles.compactControlsContent]}>{children}</View>
        </View>
      ) : undefined,
    [children, layout.showControlsFooter],
  );

  const open = useCallback(() => {
    Keyboard.dismiss();
    prepareToOpen();
    setIsOpen(true);
    onOpen?.();
  }, [onOpen, prepareToOpen]);

  const close = useCallback(() => {
    // Dismiss before unmounting the search field: a keyboard left open over a
    // disappearing sheet lands on the composer and reopens it.
    Keyboard.dismiss();
    setIsOpen(false);
    reset();
    onClose?.();
  }, [onClose, reset]);

  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      close();
    },
    [close, onSelect],
  );

  const handleApplyProfile = useCallback(
    (profileId: string) => {
      onApplyProfile?.(profileId);
      close();
    },
    [close, onApplyProfile],
  );

  const handleEditProfiles = useCallback(() => {
    close();
    onEditProfiles?.();
  }, [close, onEditProfiles]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    open();
  }, [close, isOpen, open]);

  const triggerStyle = useCallback(
    (_state: PressableStateCallbackType) => [
      hintLineStyles.control,
      disabled && hintLineStyles.controlDisabled,
    ],
    [disabled],
  );

  return (
    <>
      <ComboboxTrigger
        collapsable={false}
        disabled={disabled}
        onPress={toggle}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("modelSelector.selectedModel", {
          model: browser.selectedModelLabel,
        })}
        testID="combined-model-selector"
        chevron={null}
        hitSlop={HINT_LINE_HIT_SLOP}
      >
        {/* Daseo delta 89: `model <label> ▾` in text on the composer hint line. */}
        {({ hovered, pressed }: { hovered: boolean; pressed: boolean }) => (
          <>
            <HintWord active={hovered || pressed || isOpen}>{HINT_LINE_LABELS.model}</HintWord>
            <HintValue>{shortModelLabel(browser.triggerLabel)}</HintValue>
            <HintCaret />
          </>
        )}
      </ComboboxTrigger>

      <AdaptiveModalSheet
        header={browser.header}
        visible={isOpen}
        onClose={close}
        snapPoints={SNAP_POINTS}
        scrollable={false}
        sizeContentToCurrentSnapPoint={usesBottomSheet}
        footer={compactFooter}
        footerContainerStyle={usesBottomSheet ? styles.compactFooterContainer : undefined}
        contentStyle={styles.sheetBody}
        testID="agent-controls-model-sheet"
      >
        <View
          style={[
            styles.modelViewport,
            usesBottomSheet ? styles.flexibleModelViewport : styles.fixedModelViewport,
          ]}
          testID="agent-controls-model-viewport"
        >
          <ModelBrowser
            state={browser}
            onSelect={handleSelect}
            onApplyProfile={handleApplyProfile}
            onEditProfiles={onEditProfiles ? handleEditProfiles : undefined}
            onRetryProvider={onRetryProvider}
            isRetryingProvider={isRetryingProvider}
            scrolling={layout.scrolling}
          />
        </View>
        {!usesBottomSheet ? (
          <>
            <View style={styles.modelViewportDivider} />
            <ScrollView
              style={styles.controlsScroll}
              contentContainerStyle={styles.controlsContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              testID="agent-controls-settings-list"
            >
              {children}
            </ScrollView>
          </>
        ) : null}
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheetBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 0,
  },
  modelViewport: {
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceSidebar,
  },
  flexibleModelViewport: {
    flex: 1,
    minHeight: 0,
  },
  fixedModelViewport: {
    height: FIXED_MODEL_VIEWPORT_HEIGHT,
    minHeight: FIXED_MODEL_VIEWPORT_HEIGHT,
  },
  modelViewportDivider: {
    height: 1,
    flexShrink: 0,
    backgroundColor: theme.colors.border,
  },
  controlsScroll: {
    flex: 1,
    minHeight: 0,
  },
  compactFooterContainer: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: 0,
    paddingHorizontal: 0,
    paddingTop: 0,
    borderTopWidth: 0,
  },
  compactFooter: {
    minWidth: 0,
  },
  compactControlsContent: {
    paddingBottom: 0,
  },
  controlsContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
}));
