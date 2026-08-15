import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

const MCP_DATE_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

type JsonRpcId = string | number | null;

function isForwardProtocolVersion(
  requestedVersion: string | undefined,
): requestedVersion is string {
  return Boolean(
    requestedVersion &&
    !SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) &&
    MCP_DATE_VERSION_RE.test(requestedVersion) &&
    requestedVersion > LATEST_PROTOCOL_VERSION,
  );
}

/**
 * MCP 2.x probes for the modern protocol era with `server/discover`. The 1.x
 * transport rejects its forward-version header and reports an error before it
 * can return the -32000 response that 2.x interprets as a legacy fallback.
 * Detect that exact probe before the transport so fallback remains expected
 * control flow rather than a daemon error.
 */
export function resolveForwardAgentMcpDiscoveryFallback(input: {
  requestedVersion: string | undefined;
  body: unknown;
}): { requestId: JsonRpcId; requestedVersion: string } | null {
  const { requestedVersion, body } = input;
  if (
    !isForwardProtocolVersion(requestedVersion) ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("method" in body) ||
    body.method !== "server/discover"
  ) {
    return null;
  }

  const id = "id" in body ? body.id : null;
  const requestId = typeof id === "string" || typeof id === "number" ? id : null;
  return { requestId, requestedVersion };
}

/**
 * Let a newer MCP client reach initialize so normal protocol negotiation can
 * select the newest version this daemon supports. The SDK's HTTP transport
 * otherwise rejects the forward-version header before the MCP server can
 * return its negotiated version.
 *
 * Only forward-dated initialize requests are normalized. Unknown versions on
 * established/non-initialize requests remain strict and are rejected by the
 * SDK transport.
 */
export function resolveAgentMcpProtocolVersionOverride(input: {
  requestedVersion: string | undefined;
  body: unknown;
}): string | null {
  const { requestedVersion, body } = input;
  if (!isForwardProtocolVersion(requestedVersion) || !isInitializeRequest(body)) {
    return null;
  }

  return LATEST_PROTOCOL_VERSION;
}
