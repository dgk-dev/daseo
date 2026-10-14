import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect } from "react";
import { isNative } from "@/constants/platform";

/**
 * Keeps the screen on while `active` is true, under `tag`. Released when `active` turns false and
 * on unmount. Native only; keep-awake failures are ignored because the screen turning off is the
 * worst outcome.
 */
export function useKeepAwakeWhile(active: boolean, tag: string): void {
  useEffect(() => {
    if (!isNative || !active) {
      return;
    }
    const activation = activateKeepAwakeAsync(tag).catch(() => undefined);
    return () => {
      // Release after the activation settles so a quick toggle cannot leave the lock held.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => undefined);
    };
  }, [active, tag]);
}
