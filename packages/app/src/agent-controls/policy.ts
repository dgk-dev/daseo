import type { AgentFeatureToggle, AgentMode } from "@getpaseo/protocol/agent-types";

export const PLAN_MODE_FEATURE_ID = "plan_mode";
export const FAST_MODE_FEATURE_ID = "fast_mode";

export function resolveFeatureToggleIconName(
  feature: Pick<AgentFeatureToggle, "id" | "icon" | "value">,
): string | undefined {
  if (feature.id === FAST_MODE_FEATURE_ID) {
    return feature.value ? "zap-filled" : "zap-off";
  }
  return feature.icon;
}

export function isPlanningAgentMode(mode: Pick<AgentMode, "id" | "colorTier">): boolean {
  return mode.colorTier === "planning" || mode.id === "plan" || mode.id.endsWith("#plan");
}

export function resolveNonPlanningModeId(
  modes: readonly AgentMode[],
  defaultModeId: string | null,
): string | null {
  const defaultMode = modes.find((mode) => mode.id === defaultModeId);
  if (defaultMode && !isPlanningAgentMode(defaultMode)) {
    return defaultMode.id;
  }
  return modes.find((mode) => !isPlanningAgentMode(mode))?.id ?? null;
}
