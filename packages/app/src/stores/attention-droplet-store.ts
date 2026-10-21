import { create } from "zustand";

/**
 * The in-app attention alert (the Ovis/herdr web UI "droplet"). While the phone app is on screen
 * the OS push banner is suppressed, so an agent that finishes or asks for permission in another
 * workspace would otherwise only change a dot in the closed sidebar. One alert at a time: a newer
 * one replaces the current one, which folds away first.
 */
export type AttentionDropletReason = "finished" | "permission";

export interface AttentionDropletAlert {
  id: number;
  serverId: string;
  workspaceId: string;
  agentId: string;
  reason: AttentionDropletReason;
  /** The agent's title, else its workspace's name. */
  title: string;
  /** The notification body: the answer's first words or the permission request. */
  detail: string;
}

interface AttentionDropletState {
  current: AttentionDropletAlert | null;
  show: (alert: Omit<AttentionDropletAlert, "id">) => void;
  dismiss: (id: number) => void;
}

let nextAlertId = 1;

export const useAttentionDropletStore = create<AttentionDropletState>((set) => ({
  current: null,
  show: (alert) => {
    const id = nextAlertId;
    nextAlertId += 1;
    set({ current: { ...alert, id } });
  },
  dismiss: (id) => {
    set((state) => (state.current?.id === id ? { current: null } : state));
  },
}));
