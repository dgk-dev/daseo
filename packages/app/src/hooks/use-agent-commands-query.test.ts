import { describe, expect, it } from "vitest";
import {
  type AgentCommandsClient,
  type DraftCommandConfig,
  agentCommandsQueryTiming,
  fetchAgentCommands,
  shouldLoadAgentCommands,
} from "./use-agent-commands-query";

type ListCommands = AgentCommandsClient["listCommands"];
type ListCommandsResult = Awaited<ReturnType<ListCommands>>;

interface ListCommandsCall {
  agentId: string;
  draftConfig: DraftCommandConfig | undefined;
}

interface FakeAgentCommandsClient extends AgentCommandsClient {
  calls: ListCommandsCall[];
}

function createClient(response: ListCommandsResult): FakeAgentCommandsClient {
  const calls: ListCommandsCall[] = [];
  return {
    calls,
    listCommands: (async (options: Parameters<ListCommands>[0]) => {
      calls.push({ agentId: options.agentId, draftConfig: options.draftConfig });
      return response;
    }) as ListCommands,
  };
}

function commandsPayload(commands: ListCommandsResult["commands"]): ListCommandsResult {
  return {
    requestId: "req_commands",
    agentId: "",
    error: null,
    commands,
  };
}

describe("fetchAgentCommands", () => {
  it("loads commands for a draft composer without an agent id", async () => {
    const client = createClient(
      commandsPayload([{ name: "compact", description: "Compact context", argumentHint: "" }]),
    );

    const draftConfig: DraftCommandConfig = {
      provider: "opencode",
      cwd: "/repo",
      modeId: "build",
    };

    const commands = await fetchAgentCommands({ client, agentId: "", draftConfig });

    expect(commands).toEqual([
      { name: "compact", description: "Compact context", argumentHint: "" },
    ]);
    expect(client.calls).toEqual([{ agentId: "", draftConfig }]);
  });

  it("passes the agent id when fetching commands for a running agent", async () => {
    const client = createClient(commandsPayload([]));

    await fetchAgentCommands({ client, agentId: "agent-1" });

    expect(client.calls).toEqual([{ agentId: "agent-1", draftConfig: undefined }]);
  });
});

describe("agent commands query timing (delta 138)", () => {
  it("keeps lists for 30 minutes and refreshes a draft after 5 minutes", () => {
    expect(agentCommandsQueryTiming(true)).toEqual({ staleTime: 300_000, gcTime: 1_800_000 });
    expect(agentCommandsQueryTiming(false)).toEqual({ staleTime: 60_000, gcTime: 1_800_000 });
  });
});

describe("shouldLoadAgentCommands (delta 138)", () => {
  it("loads ahead of the first slash while the composer has focus", () => {
    expect(
      shouldLoadAgentCommands({
        commandAutocompleteOpen: false,
        composerFocused: true,
        canLoadCommands: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadAgentCommands({
        commandAutocompleteOpen: true,
        composerFocused: false,
        canLoadCommands: true,
      }),
    ).toBe(true);
  });

  it("does not load without focus or open autocomplete, or without an agent or draft", () => {
    expect(
      shouldLoadAgentCommands({
        commandAutocompleteOpen: false,
        composerFocused: false,
        canLoadCommands: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadAgentCommands({
        commandAutocompleteOpen: true,
        composerFocused: true,
        canLoadCommands: false,
      }),
    ).toBe(false);
  });
});
