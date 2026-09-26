import { beforeEach, describe, expect, it } from "vitest";
import {
  selectSideQuestionExchanges,
  sideQuestionThreadKey,
  useSideQuestionStore,
  type SideQuestionAsker,
} from "@/side-question/store";

const key = sideQuestionThreadKey("server-1", "agent-1");

function asker(
  result: () => Promise<Awaited<ReturnType<SideQuestionAsker["askAgentSideQuestion"]>>>,
) {
  const calls: unknown[] = [];
  const client: SideQuestionAsker = {
    askAgentSideQuestion: (agentId, input) => {
      calls.push({ agentId, input });
      return result();
    },
  };
  return { client, calls };
}

describe("side question store", () => {
  beforeEach(() => {
    useSideQuestionStore.setState({ threads: {}, openKey: null });
  });

  it("opens the sheet with a pending exchange, then records the answer", async () => {
    let resolve!: (value: {
      answer: { text: string; synthetic: boolean; model: string | null };
    }) => void;
    const { client, calls } = asker(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = useSideQuestionStore
      .getState()
      .ask({ key, agentId: "agent-1", question: "codename?", client });
    expect(useSideQuestionStore.getState().openKey).toBe(key);
    expect(selectSideQuestionExchanges(useSideQuestionStore.getState(), key)).toMatchObject([
      { question: "codename?", status: "pending" },
    ]);
    resolve({ answer: { text: "PAPAYA-913", synthetic: false, model: "claude-opus-5-5" } });
    await pending;
    expect(calls).toEqual([{ agentId: "agent-1", input: { question: "codename?" } }]);
    expect(selectSideQuestionExchanges(useSideQuestionStore.getState(), key)).toMatchObject([
      { status: "answered", answer: "PAPAYA-913", model: "claude-opus-5-5" },
    ]);
  });

  it("keeps a failed exchange visible with its error", async () => {
    const { client } = asker(() =>
      Promise.reject(new Error("This agent does not support side questions.")),
    );
    await useSideQuestionStore.getState().ask({ key, agentId: "agent-1", question: "q", client });
    expect(selectSideQuestionExchanges(useSideQuestionStore.getState(), key)).toMatchObject([
      { status: "failed", error: "This agent does not support side questions." },
    ]);
  });

  it("clears the local thread and the host's replay copy", async () => {
    const { client, calls } = asker(async () => ({
      answer: { text: "a", synthetic: false, model: null },
    }));
    await useSideQuestionStore.getState().ask({ key, agentId: "agent-1", question: "q", client });
    await useSideQuestionStore.getState().clear({ key, agentId: "agent-1", client });
    expect(selectSideQuestionExchanges(useSideQuestionStore.getState(), key)).toEqual([]);
    expect(calls.at(-1)).toEqual({ agentId: "agent-1", input: { clear: true } });
  });
});
