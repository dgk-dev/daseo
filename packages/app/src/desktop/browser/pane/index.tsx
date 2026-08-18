import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  PanResponder,
  Pressable,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  PanelsTopLeft,
  RotateCw,
  X,
} from "lucide-react-native";
import type { BrowserStreamFrame } from "@getpaseo/protocol/binary-frames/index";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { mapTouchToGuest } from "./remote-viewport";
import { nextRemoteStreamRetry, shouldAcceptRemoteStreamSequence } from "./remote-stream-retry";
import { useRemoteBrowserPopupTargets } from "@/desktop/browser/remote-popup-targets";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const STREAM_QUALITY = 55;
const STREAM_MAX_DIMENSION = 1600;
const STREAM_MIN_FRAME_INTERVAL_MS = 100;
const FIRST_FRAME_TIMEOUT_MS = 8_000;
const TAP_SLOP_PX = 8;
const SCROLL_SEND_INTERVAL_MS = 60;
let nextViewerOrdinal = 0;

function createViewerId(): string {
  nextViewerOrdinal += 1;
  return `mobile-browser-viewer-${Date.now().toString(36)}-${nextViewerOrdinal.toString(36)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    out += index + 1 < bytes.length ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : "=";
    out += index + 2 < bytes.length ? BASE64_ALPHABET[c & 0x3f] : "=";
  }
  return out;
}

interface FrameState {
  uri: string;
  width: number;
  height: number;
}

type StreamStatus = "connecting" | "retrying" | "live" | "stopped";
type RemoteBrowserClient = ReturnType<typeof useHostRuntimeClient>;

interface RemotePopupController {
  targets: ReturnType<typeof useRemoteBrowserPopupTargets>;
  selected: ReturnType<typeof useRemoteBrowserPopupTargets>[number] | null;
  activeBrowserId: string;
  error: string | null;
  toggle(): void;
  previous(): void;
  next(): void;
  close(): void;
}

function useRemotePopupController(input: {
  browserId: string;
  serverId: string;
  workspaceId: string;
  client: RemoteBrowserClient;
  closeFailedLabel: string;
}): RemotePopupController {
  const targets = useRemoteBrowserPopupTargets({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    rootBrowserId: input.browserId,
  });
  const [selectedBrowserId, setSelectedBrowserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = targets.find((target) => target.browserId === selectedBrowserId) ?? null;
  const selectedIndex = selected
    ? targets.findIndex((target) => target.browserId === selected.browserId)
    : -1;

  useEffect(() => {
    setSelectedBrowserId((current) =>
      current && targets.some((target) => target.browserId === current) ? current : null,
    );
  }, [targets]);
  useEffect(() => setError(null), [selectedBrowserId]);

  const toggle = useCallback(() => {
    setSelectedBrowserId((current) => (current ? null : (targets.at(-1)?.browserId ?? null)));
  }, [targets]);
  const previous = useCallback(() => {
    if (targets.length < 2) return;
    const index = Math.max(0, selectedIndex);
    setSelectedBrowserId(targets[(index - 1 + targets.length) % targets.length]?.browserId ?? null);
  }, [selectedIndex, targets]);
  const next = useCallback(() => {
    if (targets.length < 2) return;
    const index = Math.max(0, selectedIndex);
    setSelectedBrowserId(targets[(index + 1) % targets.length]?.browserId ?? null);
  }, [selectedIndex, targets]);
  const close = useCallback(() => {
    if (!input.client || !selected) return;
    void input.client
      .closeRemoteBrowserTab({ workspaceId: input.workspaceId, browserId: selected.browserId })
      .then((result) => {
        if (result.ok) setSelectedBrowserId(null);
        else setError(result.error?.message ?? input.closeFailedLabel);
        return undefined;
      })
      .catch(() => {
        setError(input.closeFailedLabel);
      });
  }, [input.client, input.closeFailedLabel, input.workspaceId, selected]);

  return {
    targets,
    selected,
    activeBrowserId: selected?.browserId ?? input.browserId,
    error,
    toggle,
    previous,
    next,
    close,
  };
}

function RemotePopupToolbarToggle({
  popup,
  foreground,
  mutedColor,
  accent,
}: {
  popup: RemotePopupController;
  foreground: string;
  mutedColor: string;
  accent: string;
}) {
  const { t } = useTranslation();
  if (popup.targets.length === 0) return null;
  return (
    <Pressable
      onPress={popup.toggle}
      style={styles.toolbarButton}
      accessibilityRole="button"
      accessibilityLabel={
        popup.selected
          ? t("workspace.browser.popups.returnToPage")
          : t("workspace.browser.popups.show", { count: popup.targets.length })
      }
    >
      <View style={styles.popupIndicator}>
        <PanelsTopLeft size={16} color={popup.selected ? accent : foreground} />
        <Text style={[styles.popupCount, { color: mutedColor }]}>{popup.targets.length}</Text>
      </View>
    </Pressable>
  );
}

function RemotePopupDetails({
  popup,
  foreground,
  mutedColor,
}: {
  popup: RemotePopupController;
  foreground: string;
  mutedColor: string;
}) {
  const { t } = useTranslation();
  if (!popup.selected) return null;
  return (
    <View style={styles.popupControlsRow}>
      {popup.targets.length > 1 ? (
        <>
          <Pressable
            onPress={popup.previous}
            style={styles.popupControlButton}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.browser.popups.previous")}
          >
            <ChevronLeft size={16} color={foreground} />
          </Pressable>
          <Pressable
            onPress={popup.next}
            style={styles.popupControlButton}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.browser.popups.next")}
          >
            <ChevronRight size={16} color={foreground} />
          </Pressable>
        </>
      ) : null}
      <Text numberOfLines={1} style={[styles.popupTitle, { color: mutedColor }]}>
        {popup.selected.title || popup.selected.url}
      </Text>
      <Pressable
        onPress={popup.close}
        style={styles.popupControlButton}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.browser.popups.close")}
      >
        <X size={16} color={foreground} />
      </Pressable>
    </View>
  );
}

export function BrowserPane({
  browserId,
  serverId,
  workspaceId,
  isInteractive = true,
  onFocusPane,
}: BrowserPaneProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const appVisible = useAppVisible();
  const retainedPanelActive = useRetainedPanelActive();
  const supportsStream = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.browserRemoteStream === true,
  );
  const popup = useRemotePopupController({
    browserId,
    serverId,
    workspaceId,
    client,
    closeFailedLabel: t("workspace.browser.popups.closeFailed"),
  });
  const activeBrowserId = popup.activeBrowserId;

  const [frame, setFrame] = useState<FrameState | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [urlText, setUrlText] = useState("");
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [viewerId] = useState(createViewerId);
  const containerSizeRef = useRef({ width: 0, height: 0 });
  const frameRef = useRef<FrameState | null>(null);
  const lastSequenceRef = useRef(-1);
  const scrollGestureRef = useRef({
    moved: false,
    lastDx: 0,
    lastDy: 0,
    pendingGuestDeltaX: 0,
    pendingGuestDeltaY: 0,
    guestX: 0,
    guestY: 0,
    lastSentAt: 0,
  });
  const shouldWatch = retainedPanelActive && appVisible && isConnected;

  const sendInput = useCallback(
    (input: Parameters<NonNullable<typeof client>["sendBrowserRemoteInput"]>[0]["input"]) => {
      if (!client) {
        return;
      }
      void client
        .sendBrowserRemoteInput({ browserId: activeBrowserId, workspaceId, input })
        .catch(() => undefined);
    },
    [activeBrowserId, client, workspaceId],
  );

  useEffect(() => {
    frameRef.current = null;
    lastSequenceRef.current = -1;
    setFrame(null);
    setStatus("connecting");
  }, [activeBrowserId]);

  useEffect(() => {
    if (!client || !supportsStream) {
      return;
    }
    if (!shouldWatch) {
      setStatus(frameRef.current ? "retrying" : "connecting");
      return;
    }
    let disposed = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
    let watchInFlight = false;
    lastSequenceRef.current = -1;
    setStatus(frameRef.current ? "retrying" : "connecting");

    const clearFirstFrameTimer = () => {
      if (firstFrameTimer) {
        clearTimeout(firstFrameTimer);
        firstFrameTimer = null;
      }
    };

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    let performRewatch = async () => {};
    const scheduleRetry = () => {
      if (disposed || retryTimer) {
        return;
      }
      const retry = nextRemoteStreamRetry({ attempt: retryAttempt });
      if (!retry) {
        setStatus("stopped");
        return;
      }
      retryAttempt = retry.nextAttempt;
      setStatus("retrying");
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void performRewatch();
      }, retry.delayMs);
    };

    const unsubscribeFrames = client.onBrowserStreamFrame((streamFrame: BrowserStreamFrame) => {
      if (
        disposed ||
        streamFrame.browserId !== activeBrowserId ||
        !shouldAcceptRemoteStreamSequence(lastSequenceRef.current, streamFrame.meta.seq)
      ) {
        return;
      }
      lastSequenceRef.current = streamFrame.meta.seq;
      clearFirstFrameTimer();
      clearRetryTimer();
      const next: FrameState = {
        uri: `data:image/jpeg;base64,${bytesToBase64(streamFrame.payload)}`,
        width: streamFrame.meta.width,
        height: streamFrame.meta.height,
      };
      frameRef.current = next;
      setFrame(next);
      setStatus("live");
    });

    const performWatch = async () => {
      if (disposed || watchInFlight) {
        return;
      }
      watchInFlight = true;
      const result = await client
        .watchBrowserStream({
          browserId: activeBrowserId,
          workspaceId,
          viewerId,
          maxWidth: STREAM_MAX_DIMENSION,
          maxHeight: STREAM_MAX_DIMENSION,
          quality: STREAM_QUALITY,
          minFrameIntervalMs: STREAM_MIN_FRAME_INTERVAL_MS,
        })
        .catch(() => ({ ok: false }) as const);
      watchInFlight = false;
      if (disposed) {
        return;
      }
      if (!result.ok) {
        scheduleRetry();
        return;
      }
      clearFirstFrameTimer();
      firstFrameTimer = setTimeout(() => {
        firstFrameTimer = null;
        scheduleRetry();
      }, FIRST_FRAME_TIMEOUT_MS);
    };

    performRewatch = async () => {
      if (disposed || watchInFlight) {
        return;
      }
      clearFirstFrameTimer();
      try {
        await client.unwatchBrowserStream({
          browserId: activeBrowserId,
          workspaceId,
          viewerId,
        });
      } catch {
        // A failed unwatch never blocks a bounded recovery attempt.
      }
      if (disposed) {
        return;
      }
      // The desktop sequence is monotonic across screencast restarts. Resetting
      // also permits recovery after a full desktop-host process restart.
      lastSequenceRef.current = -1;
      await performWatch();
    };

    void performWatch();

    return () => {
      disposed = true;
      clearRetryTimer();
      clearFirstFrameTimer();
      unsubscribeFrames();
      void client
        .unwatchBrowserStream({
          browserId: activeBrowserId,
          workspaceId,
          viewerId,
        })
        .catch(() => undefined);
    };
  }, [
    activeBrowserId,
    client,
    reconnectGeneration,
    shouldWatch,
    supportsStream,
    viewerId,
    workspaceId,
  ]);

  const flushScrollDelta = useCallback(() => {
    const gesture = scrollGestureRef.current;
    const deltaX = Math.round(gesture.pendingGuestDeltaX);
    const deltaY = Math.round(gesture.pendingGuestDeltaY);
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
      return;
    }
    gesture.pendingGuestDeltaX -= deltaX;
    gesture.pendingGuestDeltaY -= deltaY;
    gesture.lastSentAt = Date.now();
    sendInput({
      kind: "scroll",
      x: gesture.guestX,
      y: gesture.guestY,
      deltaX,
      deltaY,
    });
  }, [sendInput]);

  const mapEventToGuest = useCallback((event: GestureResponderEvent) => {
    const current = frameRef.current;
    if (!current) {
      return null;
    }
    return mapTouchToGuest({
      touchX: event.nativeEvent.locationX,
      touchY: event.nativeEvent.locationY,
      containerWidth: containerSizeRef.current.width,
      containerHeight: containerSizeRef.current.height,
      frameWidth: current.width,
      frameHeight: current.height,
    });
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isInteractive && shouldWatch && status === "live",
        onMoveShouldSetPanResponder: () => isInteractive && shouldWatch && status === "live",
        onPanResponderGrant: (event) => {
          onFocusPane?.();
          const tracker = scrollGestureRef.current;
          tracker.moved = false;
          tracker.lastDx = 0;
          tracker.lastDy = 0;
          tracker.pendingGuestDeltaX = 0;
          tracker.pendingGuestDeltaY = 0;
          const guest = mapEventToGuest(event);
          if (guest) {
            tracker.guestX = Math.round(guest.x);
            tracker.guestY = Math.round(guest.y);
          }
        },
        onPanResponderMove: (_event, gesture) => {
          const tracker = scrollGestureRef.current;
          if (
            !tracker.moved &&
            Math.abs(gesture.dx) <= TAP_SLOP_PX &&
            Math.abs(gesture.dy) <= TAP_SLOP_PX
          ) {
            return;
          }
          tracker.moved = true;
          const current = frameRef.current;
          const container = containerSizeRef.current;
          if (!current || container.width <= 0 || container.height <= 0) {
            return;
          }
          const scale = Math.min(
            container.width / current.width,
            container.height / current.height,
          );
          const deltaDx = gesture.dx - tracker.lastDx;
          const deltaDy = gesture.dy - tracker.lastDy;
          tracker.lastDx = gesture.dx;
          tracker.lastDy = gesture.dy;
          // Dragging content follows the finger, so wheel deltas use the
          // opposite direction in both axes.
          tracker.pendingGuestDeltaX += -deltaDx / Math.max(scale, 0.01);
          tracker.pendingGuestDeltaY += -deltaDy / Math.max(scale, 0.01);
          if (Date.now() - tracker.lastSentAt >= SCROLL_SEND_INTERVAL_MS) {
            flushScrollDelta();
          }
        },
        onPanResponderRelease: (event, gesture) => {
          const tracker = scrollGestureRef.current;
          if (
            !tracker.moved &&
            Math.abs(gesture.dx) <= TAP_SLOP_PX &&
            Math.abs(gesture.dy) <= TAP_SLOP_PX
          ) {
            const guest = mapEventToGuest(event);
            if (guest) {
              sendInput({ kind: "tap", x: guest.x, y: guest.y });
            }
            return;
          }
          flushScrollDelta();
        },
        onPanResponderTerminate: () => {
          flushScrollDelta();
        },
      }),
    [flushScrollDelta, isInteractive, mapEventToGuest, onFocusPane, sendInput, shouldWatch, status],
  );

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    containerSizeRef.current = {
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height,
    };
  }, []);

  const handleSubmitUrl = useCallback(() => {
    const trimmed = urlText.trim();
    if (!trimmed) {
      return;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      sendInput({ kind: "navigate", url: trimmed });
    } else if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed)) {
      sendInput({ kind: "navigate", url: `https://${trimmed}` });
    } else {
      sendInput({ kind: "text", text: trimmed });
      sendInput({ kind: "key", key: "Enter" });
    }
    setUrlText("");
  }, [sendInput, urlText]);

  const scrollBy = useCallback(
    (deltaY: number) => {
      const current = frameRef.current;
      sendInput({
        kind: "scroll",
        x: current ? Math.round(current.width / 2) : 200,
        y: current ? Math.round(current.height / 2) : 200,
        deltaX: 0,
        deltaY,
      });
    },
    [sendInput],
  );

  const handleBack = useCallback(() => sendInput({ kind: "back" }), [sendInput]);
  const handleForward = useCallback(() => sendInput({ kind: "forward" }), [sendInput]);
  const handleReload = useCallback(() => sendInput({ kind: "reload" }), [sendInput]);
  const handleScrollUp = useCallback(() => scrollBy(-600), [scrollBy]);
  const handleScrollDown = useCallback(() => scrollBy(600), [scrollBy]);
  const handleReconnect = useCallback(() => {
    setReconnectGeneration((current) => current + 1);
  }, []);
  const frameSource = useMemo(() => (frame ? { uri: frame.uri } : null), [frame]);

  const mutedColor = theme.colors.foregroundMuted;
  const foreground = theme.colors.foreground;
  const statusLabel =
    status === "stopped" ? t("workspace.browser.errors.failedToLoad") : t("common.states.loading");

  if (!supportsStream) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.title, { color: foreground }]}>
          {t("workspace.browser.unavailable.title")}
        </Text>
        <Text style={[styles.subtitle, { color: mutedColor }]}>
          {t("workspace.browser.session", { browserId })}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable
          onPress={handleBack}
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.browser.controls.back")}
        >
          <ArrowLeft size={18} color={foreground} />
        </Pressable>
        <Pressable
          onPress={handleForward}
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.browser.controls.forward")}
        >
          <ArrowRight size={18} color={foreground} />
        </Pressable>
        <Pressable
          onPress={handleReload}
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.browser.controls.refresh")}
        >
          <RotateCw size={16} color={foreground} />
        </Pressable>
        <RemotePopupToolbarToggle
          popup={popup}
          foreground={foreground}
          mutedColor={mutedColor}
          accent={theme.colors.accent}
        />
        <TextInput
          style={[styles.urlInput, { color: foreground, borderColor: theme.colors.border }]}
          value={urlText}
          onChangeText={setUrlText}
          onSubmitEditing={handleSubmitUrl}
          placeholder={t("workspace.browser.controls.enterUrl")}
          placeholderTextColor={mutedColor}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          accessibilityLabel={t("workspace.browser.controls.browserUrl")}
        />
        <Pressable
          onPress={handleSubmitUrl}
          style={styles.toolbarButton}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.browser.controls.enterUrl")}
        >
          <CornerDownLeft size={18} color={foreground} />
        </Pressable>
      </View>
      <RemotePopupDetails popup={popup} foreground={foreground} mutedColor={mutedColor} />
      {popup.error ? (
        <View style={styles.popupErrorRow}>
          <Text style={styles.popupErrorText}>{popup.error}</Text>
        </View>
      ) : null}

      <View style={styles.viewport} onLayout={handleContainerLayout} {...panResponder.panHandlers}>
        {frameSource ? (
          <Image source={frameSource} style={styles.frameImage} resizeMode="contain" />
        ) : (
          <View style={styles.streamPlaceholder}>
            <Text style={[styles.subtitle, { color: mutedColor }]}>{statusLabel}</Text>
            {status === "stopped" ? (
              <Button variant="outline" size="sm" onPress={handleReconnect}>
                {t("common.actions.retry")}
              </Button>
            ) : null}
          </View>
        )}
        {frame && status !== "live" ? (
          <View style={styles.staleOverlay} pointerEvents={status === "stopped" ? "auto" : "none"}>
            <Text style={[styles.staleText, { color: foreground }]}>{statusLabel}</Text>
            {status === "stopped" ? (
              <Button variant="outline" size="xs" onPress={handleReconnect}>
                {t("common.actions.retry")}
              </Button>
            ) : null}
          </View>
        ) : null}
      </View>

      {status === "live" ? (
        <View style={styles.scrollBar}>
          <Pressable onPress={handleScrollUp} style={styles.scrollButton}>
            <Text style={[styles.scrollGlyph, { color: mutedColor }]}>▲</Text>
          </Pressable>
          <Pressable onPress={handleScrollDown} style={styles.scrollButton}>
            <Text style={[styles.scrollGlyph, { color: mutedColor }]}>▼</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  subtitle: {
    fontSize: theme.fontSize.xs,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  toolbarButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  popupIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  popupCount: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  popupControlsRow: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  popupControlButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  popupTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  popupErrorRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  popupErrorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.xs,
  },
  urlInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    fontSize: theme.fontSize.sm,
  },
  viewport: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
  },
  frameImage: {
    width: "100%",
    height: "100%",
  },
  streamPlaceholder: {
    alignItems: "center",
    gap: theme.spacing[3],
  },
  staleOverlay: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    opacity: 0.94,
  },
  staleText: {
    fontSize: theme.fontSize.xs,
  },
  scrollBar: {
    position: "absolute",
    right: theme.spacing[1.5],
    bottom: theme.spacing[6],
    gap: theme.spacing[2],
  },
  scrollButton: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    opacity: 0.85,
  },
  scrollGlyph: {
    fontSize: theme.fontSize.sm,
  },
}));
