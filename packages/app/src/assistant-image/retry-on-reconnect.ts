/**
 * Daseo: decides when a host reconnect should retry a failed assistant image. The first
 * status a subscription reports is the current one, not a change, so it never retries; after
 * that, every arrival at "connected" from another status retries an image that is failed.
 */
export interface AssistantImageRetryOnReconnect {
  onConnectionStatus(status: string): void;
}

export function createAssistantImageRetryOnReconnect(input: {
  isFailed: () => boolean;
  retry: () => void;
}): AssistantImageRetryOnReconnect {
  let previous: string | null = null;
  return {
    onConnectionStatus(status) {
      const reconnected = previous !== null && previous !== "connected" && status === "connected";
      previous = status;
      if (reconnected && input.isFailed()) {
        input.retry();
      }
    },
  };
}
