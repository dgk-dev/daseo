import { describe, expect, it } from "vitest";
import { createAssistantImageRetryOnReconnect } from "./retry-on-reconnect";

describe("assistant image retry on reconnect", () => {
  it("retries a failed image when the host connection comes back", () => {
    let retries = 0;
    let failed = true;
    const watcher = createAssistantImageRetryOnReconnect({
      isFailed: () => failed,
      retry: () => {
        retries += 1;
      },
    });

    watcher.onConnectionStatus("connected");
    expect(retries).toBe(0);

    watcher.onConnectionStatus("disconnected");
    watcher.onConnectionStatus("connecting");
    watcher.onConnectionStatus("connected");
    expect(retries).toBe(1);

    failed = false;
    watcher.onConnectionStatus("disconnected");
    watcher.onConnectionStatus("connected");
    expect(retries).toBe(1);
  });
});
