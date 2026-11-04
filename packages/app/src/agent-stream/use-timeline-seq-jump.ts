import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "./strategy";

interface PendingSeqJump {
  requestId: number;
  seq: number;
  fetchSettled: boolean;
  hasScrolled: boolean;
}

export interface UseTimelineSeqJumpInput {
  agentId: string;
  serverId: string;
  /** Epoch of the timeline the seq belongs to; a jump waits for one. */
  epoch: string | null;
  /** A change abandons a pending jump (the agent's timeline was reset). */
  resetKey: string | null;
  loadedItems: readonly StreamItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  onJumpError: () => void;
}

/**
 * Scrolls the transcript to a timeline row, loading the window around it first
 * when it is not in memory. Shared by the chat outline and History search
 * results (Daseo delta 79).
 */
export function useTimelineSeqJump({
  agentId,
  serverId,
  epoch,
  resetKey,
  loadedItems,
  viewportRef,
  onJumpError,
}: UseTimelineSeqJumpInput): (seq: number) => void {
  const [pendingJump, setPendingJump] = useState<PendingSeqJump | null>(null);
  const nextJumpRequestIdRef = useRef(0);

  useEffect(() => {
    nextJumpRequestIdRef.current += 1;
    setPendingJump(null);
  }, [agentId, resetKey]);

  useEffect(() => {
    if (pendingJump === null) return;
    const target = loadedItems.find((item) => item.timelineCursor?.seq === pendingJump.seq);
    if (target && !pendingJump.hasScrolled) {
      viewportRef.current?.scrollToMessage?.(target.id);
      setPendingJump((current) => {
        if (current?.requestId !== pendingJump.requestId) return current;
        return { ...current, hasScrolled: true };
      });
      return;
    }
    if (pendingJump.fetchSettled) setPendingJump(null);
  }, [loadedItems, pendingJump, viewportRef]);

  return useCallback(
    (seq: number) => {
      nextJumpRequestIdRef.current += 1;
      setPendingJump(null);
      const loaded = loadedItems.find((item) => item.timelineCursor?.seq === seq);
      if (loaded) {
        viewportRef.current?.scrollToMessage?.(loaded.id);
        return;
      }
      if (!epoch) return;
      const requestId = nextJumpRequestIdRef.current;
      setPendingJump({ requestId, seq, fetchSettled: false, hasScrolled: false });
      void getHostRuntimeStore()
        .fetchAgentTimeline(serverId, agentId, planTimelinePromptJump({ epoch, seq }))
        .catch((error: unknown) => {
          console.warn("Failed to load a timeline window", error);
          onJumpError();
        })
        .finally(() => {
          setPendingJump((current) => {
            if (current?.requestId !== requestId) return current;
            return { ...current, fetchSettled: true };
          });
        });
    },
    [agentId, epoch, loadedItems, onJumpError, serverId, viewportRef],
  );
}
