import { nextRemoteStreamRetry, shouldAcceptRemoteStreamSequence } from "./remote-stream-retry";

export type RemoteStreamStatus = "connecting" | "retrying" | "live" | "stopped";

export interface RemoteStreamWatchScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: RemoteStreamWatchScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RemoteStreamWatchOptions {
  /** Subscribe this viewer to the host tab's stream; resolves false when the host refused. */
  watch: () => Promise<boolean>;
  unwatch: () => Promise<void>;
  onStatus: (status: RemoteStreamStatus) => void;
  /** A frame from an earlier watch is still on screen, so startup reads as a retry. */
  hasRetainedFrame: boolean;
  firstFrameTimeoutMs: number;
  scheduler?: RemoteStreamWatchScheduler;
}

export interface RemoteStreamWatch {
  start(): void;
  /** True when the frame is newer than everything shown and should be displayed. */
  acceptFrame(sequence: number): boolean;
  dispose(): void;
}

/**
 * One watch lifecycle of a remote browser stream viewer: subscribe, wait for the first frame,
 * retry with bounded backoff, and settle on "stopped" when every retry failed.
 *
 * A frame can arrive before the watch response (the host starts streaming as soon as the
 * daemon registers the viewer), so the first-frame timer is armed only when no frame came
 * since the watch request went out. Any accepted frame is a real recovery and restores the
 * full retry budget for the next outage.
 */
export function createRemoteStreamWatch(options: RemoteStreamWatchOptions): RemoteStreamWatch {
  const scheduler = options.scheduler ?? defaultScheduler;
  let disposed = false;
  let watchInFlight = false;
  let frameSinceWatchRequest = false;
  let retryAttempt = 0;
  let lastSequence = -1;
  let retryTimer: unknown = null;
  let firstFrameTimer: unknown = null;
  let status: RemoteStreamStatus | null = null;

  const emit = (next: RemoteStreamStatus) => {
    if (status === next) {
      return;
    }
    status = next;
    options.onStatus(next);
  };

  const clearFirstFrameTimer = () => {
    if (firstFrameTimer !== null) {
      scheduler.clearTimeout(firstFrameTimer);
      firstFrameTimer = null;
    }
  };

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      scheduler.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer !== null) {
      return;
    }
    const retry = nextRemoteStreamRetry({ attempt: retryAttempt });
    if (!retry) {
      emit("stopped");
      return;
    }
    retryAttempt = retry.nextAttempt;
    emit("retrying");
    retryTimer = scheduler.setTimeout(() => {
      retryTimer = null;
      void rewatch();
    }, retry.delayMs);
  };

  const watch = async () => {
    if (disposed || watchInFlight) {
      return;
    }
    watchInFlight = true;
    frameSinceWatchRequest = false;
    const ok = await options.watch().catch(() => false);
    watchInFlight = false;
    if (disposed) {
      return;
    }
    if (!ok) {
      scheduleRetry();
      return;
    }
    clearFirstFrameTimer();
    if (frameSinceWatchRequest) {
      return;
    }
    firstFrameTimer = scheduler.setTimeout(() => {
      firstFrameTimer = null;
      scheduleRetry();
    }, options.firstFrameTimeoutMs);
  };

  const rewatch = async () => {
    if (disposed || watchInFlight) {
      return;
    }
    clearFirstFrameTimer();
    await options.unwatch().catch(() => undefined);
    if (disposed) {
      return;
    }
    // The desktop sequence is monotonic across screencast restarts. Resetting also permits
    // recovery after a full desktop-host process restart.
    lastSequence = -1;
    await watch();
  };

  return {
    start() {
      emit(options.hasRetainedFrame ? "retrying" : "connecting");
      void watch();
    },
    acceptFrame(sequence) {
      if (disposed || !shouldAcceptRemoteStreamSequence(lastSequence, sequence)) {
        return false;
      }
      lastSequence = sequence;
      frameSinceWatchRequest = true;
      retryAttempt = 0;
      clearFirstFrameTimer();
      clearRetryTimer();
      emit("live");
      return true;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearRetryTimer();
      clearFirstFrameTimer();
      void options.unwatch().catch(() => undefined);
    },
  };
}
