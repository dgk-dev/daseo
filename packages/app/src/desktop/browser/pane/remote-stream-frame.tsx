import { memo, useMemo, useSyncExternalStore } from "react";
import { Image } from "expo-image";
import { StyleSheet } from "react-native-unistyles";

export interface RemoteStreamFrame {
  uri: string;
  width: number;
  height: number;
}

/**
 * The latest decoded-ready frame of one viewer. Frames arrive up to ten times a second; only
 * the frame surface subscribes, so the pane's toolbar, gestures, and keyboard do not render
 * per frame.
 */
export interface RemoteStreamFrameStore {
  get(): RemoteStreamFrame | null;
  set(frame: RemoteStreamFrame | null): void;
  subscribe(listener: () => void): () => void;
}

export function createRemoteStreamFrameStore(): RemoteStreamFrameStore {
  let current: RemoteStreamFrame | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(frame) {
      if (frame === current) {
        return;
      }
      current = frame;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * expo-image keeps the displayed bitmap in one of two stacked views and swaps to the other
 * only when the next frame is decoded, so a source change never shows a blank or a fade.
 * React Native's Image instead fades every new remote source in for 300 ms on Android
 * (`REMOTE_IMAGE_FADE_DURATION_MS`), which blanked a 10 fps stream. The recycling key stays
 * fixed for one browser target: changing it clears the view before the next frame loads.
 * Frames are unique and shown once, so they skip the memory and disk caches.
 */
export const RemoteStreamFrameView = memo(function RemoteStreamFrameView({
  store,
  targetKey,
}: {
  store: RemoteStreamFrameStore;
  targetKey: string;
}) {
  const frame = useSyncExternalStore(store.subscribe, store.get);
  const source = useMemo(() => (frame ? { uri: frame.uri } : null), [frame]);
  if (!source) {
    return null;
  }
  return (
    <Image
      source={source}
      style={styles.frameImage}
      contentFit="contain"
      transition={0}
      cachePolicy="none"
      recyclingKey={targetKey}
      priority="high"
    />
  );
});

const styles = StyleSheet.create({
  frameImage: {
    width: "100%",
    height: "100%",
  },
});
