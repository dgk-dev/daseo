import { describe, expect, it } from "vitest";
import { SessionOutboundMessageSchema } from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

// Daseo deltas 142 and 144: the empty-chat login banner.
const delta142Payload = {
  requestId: "r1",
  os: { type: "Darwin", release: "27.2.0", arch: "arm64" },
  loadAverage1m: 2.31,
  agentsRunning: 3,
  memory: { usedBytes: 20, totalBytes: 32 },
  swap: { usedBytes: 4 },
  lastLogin: { at: 1_795_000_000_000, from: "android" },
};

const delta144Fields = {
  disk: { usedBytes: 336, totalBytes: 460 },
  extraHeaders: [{ label: "Dev servers:", value: "2 (3.1GB)" }],
  notes: [
    { severity: "critical", text: "Memory pressure is critical: Google Chrome 3.1GB" },
    { severity: "warning", text: "/ is using 86.0% of 460GB" },
  ],
  restartRequired: { version: "0.5.152" },
};

function response(payload: Record<string, unknown>) {
  return { type: "daemon.get_login_banner.response", payload };
}

describe("daemon.get_login_banner.response", () => {
  it("still parses what a delta 142 daemon sends", () => {
    const message = response(delta142Payload);
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
  });

  it("parses the delta 144 fields", () => {
    const message = response({ ...delta142Payload, ...delta144Fields });
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
  });

  it("accepts a note severity this build does not know, so a later daemon cannot break it", () => {
    const message = response({
      requestId: "r1",
      notes: [{ severity: "info", text: "a later level" }],
    });
    expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
  });
});
