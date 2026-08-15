import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

const MCP_DATE_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (
    !requestedVersion ||
    SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ||
    !MCP_DATE_VERSION_RE.test(requestedVersion) ||
    requestedVersion <= LATEST_PROTOCOL_VERSION ||
    !isInitializeRequest(body)
  ) {
    return null;
  }

  return LATEST_PROTOCOL_VERSION;
}
