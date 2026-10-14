import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useRef } from "react";
import { isNative } from "@/constants/platform";

/**
 * Keeps the screen on while `active` is true, under `tag`. Released when `active` turns false and
 * on unmount. Native only; keep-awake failures are ignored because the screen turning off is the
 * worst outcome.
 */
export function useKeepAwakeWhile(active: boolean, tag: string): void {
  // Every activate and release of this hook runs in order on one chain. expo-keep-awake keeps one
  // entry per tag, so a release that ran after a later activate would drop the lock while
  // `active` is true (a quick disconnect/reconnect flips it false and back).
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!isNative || !active) {
      return;
    }
    queueRef.current = queueRef.current
      .then(() => activateKeepAwakeAsync(tag))
      .catch(() => undefined);
    return () => {
      queueRef.current = queueRef.current
        .then(() => deactivateKeepAwake(tag))
        .catch(() => undefined);
    };
  }, [active, tag]);
}
