import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";
import {
  resolveAgentMcpProtocolVersionOverride,
  resolveForwardAgentMcpDiscoveryFallback,
} from "./agent-mcp-protocol.js";

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "forward-client", version: "1.0.0" },
  },
};

describe("resolveForwardAgentMcpDiscoveryFallback", () => {
  test("classifies a modern era probe as legacy fallback control flow", () => {
    expect(
      resolveForwardAgentMcpDiscoveryFallback({
        requestedVersion: "2026-07-28",
        body: {
          jsonrpc: "2.0",
          id: "probe-1",
          method: "server/discover",
          params: { _meta: { protocolVersion: "2026-07-28" } },
        },
      }),
    ).toEqual({ requestId: "probe-1", requestedVersion: "2026-07-28" });
  });

  test.each([
    [LATEST_PROTOCOL_VERSION, { id: 1, method: "server/discover" }],
    ["2026-07-28", { id: 1, method: "initialize" }],
    ["future", { id: 1, method: "server/discover" }],
  ])(
    "keeps non-forward-discovery requests on the normal transport path",
    (requestedVersion, body) => {
      expect(resolveForwardAgentMcpDiscoveryFallback({ requestedVersion, body })).toBeNull();
    },
  );
});

describe("resolveAgentMcpProtocolVersionOverride", () => {
  test("normalizes a forward-dated initialize request for protocol negotiation", () => {
    expect(
      resolveAgentMcpProtocolVersionOverride({
        requestedVersion: "2026-07-28",
        body: initializeBody,
      }),
    ).toBe(LATEST_PROTOCOL_VERSION);
  });

  test.each([
    [undefined, initializeBody],
    [LATEST_PROTOCOL_VERSION, initializeBody],
    ["2025-01-01", initializeBody],
    ["future", initializeBody],
    ["2026-07-28", { ...initializeBody, method: "tools/list" }],
  ])("keeps strict transport validation for %s", (requestedVersion, body) => {
    expect(resolveAgentMcpProtocolVersionOverride({ requestedVersion, body })).toBeNull();
  });
});
