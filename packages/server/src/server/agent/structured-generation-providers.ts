import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import type { StructuredGenerationProvider } from "./agent-response-loop.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

export interface StructuredGenerationDaemonConfig {
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
}

export interface StructuredGenerationProviderIdentifier {
  modelSubstring: string;
  thinkingOptionId?: string;
  /** Daseo: among several matches, pick the highest model version, not the first listed. */
  preferNewest?: boolean;
}

export const DEFAULT_STRUCTURED_GENERATION_PROVIDERS: readonly StructuredGenerationProviderIdentifier[] =
  [
    // Daseo: Pi exposes only the roster models; Luna is the cheap one there. Match
    // the family, not a version, so a roster upgrade (gpt-6.1-luna, gpt-7-luna)
    // is picked up without a code change.
    { modelSubstring: "luna", thinkingOptionId: "low", preferNewest: true },
    { modelSubstring: "haiku" },
    { modelSubstring: "gpt-5.4-mini", thinkingOptionId: "low" },
    { modelSubstring: "minimax-m3" },
    { modelSubstring: "nemotron-3-super" },
  ] as const;

export interface ResolveStructuredGenerationProvidersOptions {
  cwd: string;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  currentSelection?: {
    provider?: AgentProvider | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  };
}

export async function resolveStructuredGenerationProviders(
  options: ResolveStructuredGenerationProvidersOptions,
): Promise<StructuredGenerationProvider[]> {
  const configuredProviders = readConfiguredProviders(options.daemonConfig);
  const providerEntries = await options.providerSnapshotManager.listProviders({
    cwd: options.cwd,
    wait: true,
  });
  const enabledEntries = providerEntries.filter((entry) => entry.enabled);
  const modelEntries = enabledEntries.filter((entry) => (entry.models?.length ?? 0) > 0);
  const entriesByProvider = new Map(enabledEntries.map((entry) => [entry.provider, entry]));
  const providers: StructuredGenerationProvider[] = [];

  for (const configured of configuredProviders) {
    const resolvedConfigured = resolveConfiguredCandidate(
      configured,
      modelEntries,
      entriesByProvider,
    );
    if (!resolvedConfigured) {
      continue;
    }
    providers.push(resolvedConfigured);
  }

  for (const identifier of DEFAULT_STRUCTURED_GENERATION_PROVIDERS) {
    const resolved = resolveByModelSubstring(modelEntries, identifier);
    if (resolved) {
      providers.push(resolved);
    }
  }

  const currentSelection = resolveCurrentSelection(
    options.currentSelection,
    modelEntries,
    entriesByProvider,
  );
  if (currentSelection) {
    providers.push(currentSelection);
  }

  return dedupeProviders(providers);
}

function resolveCurrentSelection(
  selection: ResolveStructuredGenerationProvidersOptions["currentSelection"],
  readyEntries: readonly ProviderSnapshotEntry[],
  entriesByProvider: ReadonlyMap<AgentProvider, ProviderSnapshotEntry>,
): StructuredGenerationProvider | null {
  if (!selection) {
    return null;
  }

  const provider = selection.provider?.trim();
  if (!provider) {
    return null;
  }

  const normalized = resolveConfiguredCandidate(
    {
      provider,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.thinkingOptionId ? { thinkingOptionId: selection.thinkingOptionId } : {}),
    },
    readyEntries,
    entriesByProvider,
  );
  if (normalized) {
    return normalized;
  }

  const explicitModel = selection.model?.trim();
  if (explicitModel) {
    return {
      provider,
      model: explicitModel,
      ...(selection.thinkingOptionId ? { thinkingOptionId: selection.thinkingOptionId } : {}),
    };
  }

  const model = selectDefaultModel(entriesByProvider.get(provider)?.models ?? []);
  if (!model) {
    return { provider };
  }

  const thinkingOptionId = resolveThinkingOptionId(model, selection.thinkingOptionId);
  return {
    provider,
    model: model.id,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

function resolveConfiguredCandidate(
  candidate: { provider: string; model?: string; thinkingOptionId?: string },
  readyEntries: readonly ProviderSnapshotEntry[],
  entriesByProvider: ReadonlyMap<AgentProvider, ProviderSnapshotEntry>,
): StructuredGenerationProvider | null {
  const provider = candidate.provider.trim();
  if (!provider) {
    return null;
  }

  const topLevelEntry = entriesByProvider.get(provider);
  const configuredModel = candidate.model?.trim();
  if (topLevelEntry) {
    if (configuredModel) {
      return {
        provider,
        model: configuredModel,
        ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
      };
    }

    const model = selectDefaultModel(topLevelEntry.models ?? []);
    const thinkingOptionId = resolveThinkingOptionId(model, candidate.thinkingOptionId);
    return {
      provider,
      ...(model ? { model: model.id } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }

  if (!configuredModel) {
    return {
      provider,
      ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
    };
  }

  const nestedMatch = resolveNestedProviderModel(provider, configuredModel, readyEntries);
  if (!nestedMatch) {
    return {
      provider,
      model: configuredModel,
      ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
    };
  }

  const thinkingOptionId = resolveThinkingOptionId(nestedMatch.model, candidate.thinkingOptionId);
  return {
    provider: nestedMatch.provider,
    model: nestedMatch.model.id,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

function resolveNestedProviderModel(
  providerId: string,
  modelId: string,
  entries: readonly ProviderSnapshotEntry[],
): { provider: AgentProvider; model: AgentModelDefinition } | null {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelId = modelId.trim().toLowerCase();

  for (const entry of entries) {
    for (const model of entry.models ?? []) {
      const modelProviderId = readModelMetadataString(model, "providerId")?.toLowerCase();
      const nestedModelId = readModelMetadataString(model, "modelId")?.toLowerCase();
      if (modelProviderId !== normalizedProviderId) {
        continue;
      }
      if (
        normalizedModelId === model.id.toLowerCase() ||
        normalizedModelId === nestedModelId ||
        model.id.toLowerCase() === `${normalizedProviderId}/${normalizedModelId}`
      ) {
        return { provider: entry.provider, model };
      }
    }
  }

  return null;
}

function resolveByModelSubstring(
  entries: readonly ProviderSnapshotEntry[],
  identifier: StructuredGenerationProviderIdentifier,
): StructuredGenerationProvider | null {
  const needle = identifier.modelSubstring.trim().toLowerCase();
  if (!needle) {
    return null;
  }

  const matches: Array<{ provider: AgentProvider; model: AgentModelDefinition }> = [];
  for (const entry of entries) {
    for (const model of entry.models ?? []) {
      const haystacks = [model.id, model.label].map((value) => value.toLowerCase());
      if (haystacks.some((value) => value.includes(needle))) {
        matches.push({ provider: entry.provider, model });
      }
    }
  }
  const chosen = identifier.preferNewest
    ? matches.reduce<(typeof matches)[number] | undefined>(
        (best, candidate) =>
          !best || compareModelVersions(candidate.model.id, best.model.id) > 0 ? candidate : best,
        undefined,
      )
    : matches[0];
  if (!chosen) {
    return null;
  }
  const thinkingOptionId = resolveThinkingOptionId(chosen.model, identifier.thinkingOptionId);
  return {
    provider: chosen.provider,
    model: chosen.model.id,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

// Compares the first dotted number in two model ids: gpt-6.1-luna > gpt-6-luna.
function compareModelVersions(left: string, right: string): number {
  const parse = (id: string) =>
    (id.match(/\d+(?:\.\d+)*/)?.[0] ?? "0").split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function readConfiguredProviders(
  daemonConfig: ResolveStructuredGenerationProvidersOptions["daemonConfig"],
): Array<{ provider: string; model?: string; thinkingOptionId?: string }> {
  const metadataGeneration = daemonConfig?.metadataGeneration;
  if (!metadataGeneration || typeof metadataGeneration !== "object") {
    return [];
  }
  const providers = "providers" in metadataGeneration ? metadataGeneration.providers : undefined;
  return Array.isArray(providers) ? providers : [];
}

function selectDefaultModel(models: readonly AgentModelDefinition[]): AgentModelDefinition | null {
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

function resolveThinkingOptionId(
  model: AgentModelDefinition | null | undefined,
  preferredThinkingOptionId: string | null | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }
  if (
    preferredThinkingOptionId &&
    model.thinkingOptions?.some((option) => option.id === preferredThinkingOptionId)
  ) {
    return preferredThinkingOptionId;
  }
  return model.defaultThinkingOptionId;
}

function dedupeProviders(
  providers: readonly StructuredGenerationProvider[],
): StructuredGenerationProvider[] {
  const seen = new Set<string>();
  const deduped: StructuredGenerationProvider[] = [];

  for (const provider of providers) {
    const key = [provider.provider, provider.model ?? "", provider.thinkingOptionId ?? ""].join(
      "\0",
    );
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(provider);
  }

  return deduped;
}

function readModelMetadataString(model: AgentModelDefinition, key: string): string | undefined {
  const value = model.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
