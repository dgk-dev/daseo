import React, { type ReactNode } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { CompactExplorerSidebarHost } from "@/components/compact-explorer-sidebar-host";
import { isWeb } from "@/constants/platform";
import { useOpenAgentListGesture } from "@/mobile-panels/gestures";
import { type WindowChromeCorners, WindowChromeRegion } from "@/utils/desktop-window";

const rowStyle = { flex: 1, flexDirection: "row" } as const;
const flexStyle = { flex: 1 } as const;
const MOBILE_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

interface AppSurfaceFrameProps {
  isCompactLayout: boolean;
  chromeEnabled: boolean;
  /** The pinned sidebar, drawn in the row before the content in wide layouts only. */
  sidebar: ReactNode;
  sidebarCorners: WindowChromeCorners;
  contentCorners: WindowChromeCorners;
  surfaceStyle: StyleProp<ViewStyle>;
  /** Surface-level siblings drawn after the row: toggles, portal host, dialogs. */
  overlays: ReactNode;
  /** The routed screens. */
  children: ReactNode;
}

/**
 * Daseo delta 150: the app surface renders the same element types in the compact and the wide
 * layout, so crossing the compact width (folding or unfolding the phone, resizing a desktop window
 * across 720 px) keeps the routed screens mounted. The compact-only wrappers stay in the tree in
 * both layouts with their gestures disabled when wide; a disabled gesture detector on web restores
 * the view's own `user-select` and `touch-action` and drops its pointer listeners.
 */
export function AppSurfaceFrame({
  isCompactLayout,
  chromeEnabled,
  sidebar,
  sidebarCorners,
  contentCorners,
  surfaceStyle,
  overlays,
  children,
}: AppSurfaceFrameProps) {
  const compactChromeEnabled = isCompactLayout && chromeEnabled;
  return (
    <MobileGestureWrapper enabled={compactChromeEnabled} style={surfaceStyle}>
      <View style={surfaceStyle}>
        <View style={rowStyle}>
          {!isCompactLayout ? (
            <WindowChromeRegion corners={sidebarCorners}>{sidebar}</WindowChromeRegion>
          ) : null}
          <CompactExplorerSidebarHost enabled={compactChromeEnabled}>
            <WindowChromeRegion corners={compactChromeEnabled ? "both" : contentCorners}>
              <View style={flexStyle}>{children}</View>
            </WindowChromeRegion>
          </CompactExplorerSidebarHost>
        </View>
        {overlays}
      </View>
    </MobileGestureWrapper>
  );
}

function MobileGestureWrapper({
  children,
  enabled,
  style,
}: {
  children: ReactNode;
  enabled: boolean;
  style: StyleProp<ViewStyle>;
}) {
  const openGesture = useOpenAgentListGesture(enabled);

  return (
    <GestureDetector gesture={openGesture} touchAction={MOBILE_WEB_GESTURE_TOUCH_ACTION}>
      <View collapsable={false} style={style}>
        {children}
      </View>
    </GestureDetector>
  );
}
