import { createContext, useContext } from "react";
import type { WorkActivityCounts } from "./collapsed-work";

/**
 * Lets the completed-turn footer reach the collapsed-work state owned by the
 * stream view without threading props through every layout layer. Absent
 * provider (tests, previews) renders no expand control.
 */
export interface CollapsedWorkController {
  getWorkCount: (turnKey: string) => number;
  getWorkActivity: (turnKey: string) => WorkActivityCounts | undefined;
  getDurationMs: (turnKey: string) => number | undefined;
  isExpanded: (turnKey: string) => boolean;
  toggle: (turnKey: string) => void;
}

const CollapsedWorkContext = createContext<CollapsedWorkController | null>(null);

export const CollapsedWorkProvider = CollapsedWorkContext.Provider;

export function useCollapsedWork(): CollapsedWorkController | null {
  return useContext(CollapsedWorkContext);
}
