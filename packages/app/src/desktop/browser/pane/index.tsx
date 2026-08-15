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
import { ArrowLeft, ArrowRight, CornerDownLeft, RotateCw } from "lucide-react-native";
import type { BrowserStreamFrame } from "@getpaseo/protocol/binary-frames/index";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { mapTouchToGuest } from "./remote-viewport";

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
const STALL_TIMEOUT_MS = 8_000;
const REWATCH_INTERVAL_MS = 5_000;
const TAP_SLOP_PX = 8;
const SCROLL_SEND_INTERVAL_MS = 60;

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

export function BrowserPane({ browserId, serverId, isInteractive = true }: BrowserPaneProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const supportsStream = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.browserRemoteStream === true,
  );

  const [frame, setFrame] = useState<FrameState | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "stalled" | "error">("connecting");
  const [urlText, setUrlText] = useState("");
  const containerSizeRef = useRef({ width: 0, height: 0 });
  const frameRef = useRef<FrameState | null>(null);
  const lastFrameAtRef = useRef(0);
  const scrollGestureRef = useRef({
    moved: false,
    lastDy: 0,
    pendingGuestDelta: 0,
    guestX: 0,
    guestY: 0,
    lastSentAt: 0,
  });

  const sendInput = useCallback(
    (input: Parameters<NonNullable<typeof client>["sendBrowserRemoteInput"]>[0]["input"]) => {
      if (!client) {
        return;
      }
      void client.sendBrowserRemoteInput({ browserId, input }).catch(() => undefined);
    },
    [browserId, client],
  );

  useEffect(() => {
    if (!client || !supportsStream) {
      return;
    }
    let disposed = false;
    let watchStartedAt = Date.now();
    let rewatchInFlight = false;
    lastFrameAtRef.current = 0;
    frameRef.current = null;
    setFrame(null);
    setStatus("connecting");

    const unsubscribeFrames = client.onBrowserStreamFrame((streamFrame: BrowserStreamFrame) => {
      if (disposed || streamFrame.browserId !== browserId) {
        return;
      }
      lastFrameAtRef.current = Date.now();
      const next: FrameState = {
        uri: `data:image/jpeg;base64,${bytesToBase64(streamFrame.payload)}`,
        width: streamFrame.meta.width,
        height: streamFrame.meta.height,
      };
      frameRef.current = next;
      setFrame(next);
      setStatus("live");
    });

    const watch = async () => {
      watchStartedAt = Date.now();
      const result = await client
        .watchBrowserStream({
          browserId,
          maxWidth: STREAM_MAX_DIMENSION,
          maxHeight: STREAM_MAX_DIMENSION,
          quality: STREAM_QUALITY,
        })
        .catch(() => ({ ok: false }) as const);
      if (disposed) {
        return;
      }
      setStatus((current) => {
        if (result.ok) {
          return current === "live" ? current : "connecting";
        }
        return "error";
      });
    };
    void watch();

    const rewatch = async () => {
      if (disposed || rewatchInFlight) return;
      rewatchInFlight = true;
      try {
        try {
          await client.unwatchBrowserStream(browserId);
        } catch {
          // A failed unwatch never blocks the retry.
        }
        if (!disposed) await watch();
      } finally {
        rewatchInFlight = false;
      }
    };

    const stallTimer = setInterval(() => {
      if (disposed) return;
      const latestActivityAt = lastFrameAtRef.current || watchStartedAt;
      if (Date.now() - latestActivityAt < STALL_TIMEOUT_MS) return;
      setStatus((current) => (current === "live" ? "stalled" : current));
      // The desktop host may have restarted; drop the stale subscription and
      // start one bounded retry at a time.
      void rewatch();
    }, REWATCH_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(stallTimer);
      unsubscribeFrames();
      void client.unwatchBrowserStream(browserId).catch(() => undefined);
    };
  }, [browserId, client, supportsStream]);

  const flushScrollDelta = useCallback(() => {
    const gesture = scrollGestureRef.current;
    const deltaY = Math.round(gesture.pendingGuestDelta);
    if (Math.abs(deltaY) < 1) {
      return;
    }
    gesture.pendingGuestDelta -= deltaY;
    gesture.lastSentAt = Date.now();
    sendInput({
      kind: "scroll",
      x: gesture.guestX,
      y: gesture.guestY,
      deltaX: 0,
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
        onStartShouldSetPanResponder: () => isInteractive,
        onMoveShouldSetPanResponder: () => isInteractive,
        onPanResponderGrant: (event) => {
          const tracker = scrollGestureRef.current;
          tracker.moved = false;
          tracker.lastDy = 0;
          tracker.pendingGuestDelta = 0;
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
          const deltaDy = gesture.dy - tracker.lastDy;
          tracker.lastDy = gesture.dy;
          // Dragging the finger up moves the page content up: scroll down.
          tracker.pendingGuestDelta += -deltaDy / Math.max(scale, 0.01);
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
    [flushScrollDelta, isInteractive, mapEventToGuest, sendInput],
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
  const frameSource = useMemo(() => (frame ? { uri: frame.uri } : null), [frame]);

  const mutedColor = theme.colors.foregroundMuted;
  const foreground = theme.colors.foreground;

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

      <View style={styles.viewport} onLayout={handleContainerLayout} {...panResponder.panHandlers}>
        {frameSource ? (
          <Image source={frameSource} style={styles.frameImage} resizeMode="contain" />
        ) : (
          <Text style={[styles.subtitle, { color: mutedColor }]}>
            {status === "error"
              ? t("workspace.browser.errors.failedToLoad")
              : t("providerSelection.loading")}
          </Text>
        )}
        {frame && status !== "live" ? (
          <View style={styles.staleOverlay} pointerEvents="none">
            <Text style={[styles.staleText, { color: foreground }]}>
              {t("providerSelection.loading")}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.scrollBar}>
        <Pressable onPress={handleScrollUp} style={styles.scrollButton}>
          <Text style={[styles.scrollGlyph, { color: mutedColor }]}>▲</Text>
        </Pressable>
        <Pressable onPress={handleScrollDown} style={styles.scrollButton}>
          <Text style={[styles.scrollGlyph, { color: mutedColor }]}>▼</Text>
        </Pressable>
      </View>
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
    gap: 8,
    padding: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: 12,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  toolbarButton: {
    padding: 8,
    borderRadius: 8,
  },
  urlInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
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
  staleOverlay: {
    position: "absolute",
    top: 8,
    right: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surface1,
    opacity: 0.9,
  },
  staleText: {
    fontSize: 11,
  },
  scrollBar: {
    position: "absolute",
    right: 6,
    bottom: 24,
    gap: 8,
  },
  scrollButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    opacity: 0.85,
  },
  scrollGlyph: {
    fontSize: 14,
  },
}));
