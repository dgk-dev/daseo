import type { AgentProvider } from "@getpaseo/protocol/agent-types";

// Daseo fork: new-session forms for these providers always start from the
// provider's advertised defaults (default model, per-model thinking level,
// feature values) instead of the sticky last-used preferences.
const PINNED_DEFAULT_PROVIDERS: ReadonlySet<string> = new Set(["pi"]);

export function hasPinnedProviderDefaults(
  provider: AgentProvider | string | null | undefined,
): boolean {
  return typeof provider === "string" && PINNED_DEFAULT_PROVIDERS.has(provider);
}
