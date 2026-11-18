import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCRequest,
  type CallToolResult,
  type JSONRPCMessage,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolCatalog, PaseoToolResult } from "./tools/types.js";

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

/**
 * Gives a tool's normalizeInput the raw tools/call arguments before McpServer
 * validates them against the inputSchema it advertises. The SDK validates and
 * advertises from the same schema object, so renaming a sent argument has to
 * happen before the request reaches it (Daseo delta 129).
 */
function normalizeToolCallMessage(
  message: JSONRPCMessage,
  catalog: PaseoToolCatalog,
): JSONRPCMessage {
  if (!isJSONRPCRequest(message) || message.method !== "tools/call") {
    return message;
  }
  const params = message.params;
  const name = params?.name;
  if (typeof name !== "string" || !params || !("arguments" in params)) {
    return message;
  }
  const normalizeInput = catalog.getTool(name)?.normalizeInput;
  if (!normalizeInput) {
    return message;
  }
  return { ...message, params: { ...params, arguments: normalizeInput(params.arguments) } };
}

class AgentMcpServer extends McpServer {
  public constructor(private readonly catalog: PaseoToolCatalog) {
    super({ name: "agent-mcp", version: "2.0.0" });
  }

  public override async connect(transport: Transport): Promise<void> {
    await super.connect(transport);
    // connect() installed the protocol's receiver; wrap it so tools/call arguments are
    // normalized first. Transports deliver messages only after connect resolves.
    const deliver = transport.onmessage;
    if (!deliver) {
      return;
    }
    const catalog = this.catalog;
    // Transports are plain callback holders with no addEventListener (as in bootstrap).
    const onmessage: Transport["onmessage"] = (message, extra) =>
      deliver(normalizeToolCallMessage(message, catalog), extra);
    Object.assign(transport, { onmessage });
  }
}

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options);
  const server = new AgentMcpServer(catalog);

  for (const tool of catalog.tools.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  return server;
}
