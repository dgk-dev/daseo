import { create } from "zustand";

/**
 * `/btw` side threads, one per agent. Side questions never enter the agent's
 * timeline, so this in-memory store is their only record on the client. Like
 * Claude Code's `/btw`, the thread lasts until it is cleared or the app exits.
 */

export type SideQuestionExchangeStatus = "pending" | "answered" | "failed";

export interface SideQuestionExchange {
  id: number;
  question: string;
  status: SideQuestionExchangeStatus;
  answer: string | null;
  /** The answer is a note from the host rather than a model reply. */
  synthetic: boolean;
  model: string | null;
  error: string | null;
}

export interface SideQuestionAsker {
  askAgentSideQuestion(
    agentId: string,
    input: { question: string } | { clear: true },
  ): Promise<{
    answer: { text: string; synthetic: boolean; model: string | null } | null;
  }>;
}

interface SideQuestionThread {
  exchanges: SideQuestionExchange[];
}

interface SideQuestionStoreState {
  threads: Record<string, SideQuestionThread>;
  /** The thread whose sheet is open, if any. */
  openKey: string | null;
  open: (key: string) => void;
  close: () => void;
  ask: (input: {
    key: string;
    agentId: string;
    question: string;
    client: SideQuestionAsker;
  }) => Promise<void>;
  clear: (input: {
    key: string;
    agentId: string;
    client: SideQuestionAsker | null;
  }) => Promise<void>;
}

export function sideQuestionThreadKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

let nextExchangeId = 1;

function updateExchange(
  threads: Record<string, SideQuestionThread>,
  key: string,
  id: number,
  patch: Partial<SideQuestionExchange>,
): Record<string, SideQuestionThread> {
  const thread = threads[key];
  const index = thread?.exchanges.findIndex((exchange) => exchange.id === id) ?? -1;
  if (!thread || index < 0) {
    return threads;
  }
  const exchanges = thread.exchanges.slice();
  exchanges[index] = { ...exchanges[index], ...patch };
  return { ...threads, [key]: { exchanges } };
}

export const useSideQuestionStore = create<SideQuestionStoreState>()((set) => ({
  threads: {},
  openKey: null,
  open: (key) => set({ openKey: key }),
  close: () => set({ openKey: null }),
  ask: async ({ key, agentId, question, client }) => {
    const id = nextExchangeId++;
    set((state) => ({
      openKey: key,
      threads: {
        ...state.threads,
        [key]: {
          exchanges: [
            ...(state.threads[key]?.exchanges ?? []),
            {
              id,
              question,
              status: "pending",
              answer: null,
              synthetic: false,
              model: null,
              error: null,
            },
          ],
        },
      },
    }));
    try {
      const payload = await client.askAgentSideQuestion(agentId, { question });
      if (!payload.answer) {
        throw new Error("No answer");
      }
      const { text, synthetic, model } = payload.answer;
      set((state) => ({
        threads: updateExchange(state.threads, key, id, {
          status: "answered",
          answer: text,
          synthetic,
          model,
        }),
      }));
    } catch (error) {
      set((state) => ({
        threads: updateExchange(state.threads, key, id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },
  clear: async ({ key, agentId, client }) => {
    set((state) => {
      const { [key]: _removed, ...threads } = state.threads;
      return { threads };
    });
    // The host keeps its own copy of the thread for replay; clear that too.
    await client?.askAgentSideQuestion(agentId, { clear: true });
  },
}));

export function selectSideQuestionExchanges(
  state: Pick<SideQuestionStoreState, "threads">,
  key: string,
): SideQuestionExchange[] {
  return state.threads[key]?.exchanges ?? EMPTY_EXCHANGES;
}

const EMPTY_EXCHANGES: SideQuestionExchange[] = [];
