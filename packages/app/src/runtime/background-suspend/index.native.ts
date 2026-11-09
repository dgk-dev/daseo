import { AppState } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import { getIsAppVisible } from "@/utils/app-visibility";
import {
  createBackgroundSuspendController,
  type BackgroundSuspendController,
  type BackgroundSuspendScheduler,
  type BackgroundSuspendTarget,
} from "./controller";

interface DaseoBackgroundSuspendModule {
  schedule(id: number, delayMs: number): void;
  cancel(id: number): void;
  releaseMemory(): void;
  addListener(eventName: "onFire", handler: (event: { id: number }) => void): EventSubscription;
}

// Android only (modules/daseo-background-suspend); iOS suspends the whole app instead.
const nativeModule =
  requireOptionalNativeModule<DaseoBackgroundSuspendModule>("DaseoBackgroundSuspend");

function createNativeTimerScheduler(module: DaseoBackgroundSuspendModule): {
  scheduler: BackgroundSuspendScheduler;
  dispose: () => void;
} {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  const subscription = module.addListener("onFire", ({ id }) => {
    const callback = callbacks.get(id);
    if (!callback) {
      return;
    }
    callbacks.delete(id);
    callback();
  });
  return {
    scheduler: {
      schedule(delayMs, callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        module.schedule(id, delayMs);
        return () => {
          if (callbacks.delete(id)) {
            module.cancel(id);
          }
        };
      },
    },
    dispose: () => {
      subscription.remove();
      for (const id of callbacks.keys()) {
        module.cancel(id);
      }
      callbacks.clear();
    },
  };
}

const timeoutScheduler: BackgroundSuspendScheduler = {
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

let controller: BackgroundSuspendController | null = null;

/** Daseo delta 86: suspends the host connections while the native app is not visible. */
export function startBackgroundSuspend(target: BackgroundSuspendTarget): () => void {
  if (controller) {
    return () => {};
  }
  const nativeTimer = nativeModule ? createNativeTimerScheduler(nativeModule) : null;
  const started = createBackgroundSuspendController({
    target: {
      setBackgroundSuspended(suspended) {
        target.setBackgroundSuspended(suspended);
        if (suspended) {
          // Nothing is on screen and the stream has stopped: collect the stale render state now.
          nativeModule?.releaseMemory();
        }
      },
    },
    scheduler: nativeTimer?.scheduler ?? timeoutScheduler,
    initiallyVisible: getIsAppVisible(),
  });
  controller = started;
  const subscription = AppState.addEventListener("change", (state) => {
    started.setVisible(getIsAppVisible(state));
  });
  return () => {
    subscription.remove();
    started.dispose();
    nativeTimer?.dispose();
    target.setBackgroundSuspended(false);
    if (controller === started) {
      controller = null;
    }
  };
}

/**
 * Keeps the daemon connection while a recording streams over it (dictation, voice): the
 * suspend waits for the release instead of cutting the recording.
 */
export function holdDaemonConnection(): () => void {
  return controller?.hold() ?? (() => {});
}
