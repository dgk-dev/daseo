import type { AgentProviderSelectionPolicy } from "@getpaseo/protocol/agent-types";
import type { AgentModelDefinition } from "./agent-sdk-types.js";

function modelReferences(model: Pick<AgentModelDefinition, "id" | "aliases">): string[] {
  return [model.id, ...(model.aliases ?? [])];
}

function findPolicyValue<T>(
  values: Record<string, T> | undefined,
  model: Pick<AgentModelDefinition, "id" | "aliases">,
): T | undefined {
  for (const reference of modelReferences(model)) {
    if (Object.prototype.hasOwnProperty.call(values ?? {}, reference)) {
      return values?.[reference];
    }
  }
  return undefined;
}

export function resolveSelectionPolicyThinkingDefault(
  policy: AgentProviderSelectionPolicy | undefined,
  modelReference: string | null | undefined,
): string | undefined {
  if (!modelReference) return undefined;
  const values = policy?.thinkingDefaultsByModel;
  if (!values) return undefined;
  if (Object.prototype.hasOwnProperty.call(values, modelReference)) {
    return values[modelReference];
  }

  const unqualified = modelReference.includes("/")
    ? modelReference.slice(modelReference.indexOf("/") + 1)
    : modelReference;
  return Object.prototype.hasOwnProperty.call(values, unqualified)
    ? values[unqualified]
    : undefined;
}

export function resolveSelectionPolicyFeatureDefaults(
  policy: AgentProviderSelectionPolicy | undefined,
  modelReference: string | null | undefined,
): Record<string, unknown> {
  if (!modelReference) return {};
  const values = policy?.featureDefaultsByModel;
  if (!values) return {};
  if (Object.prototype.hasOwnProperty.call(values, modelReference)) {
    return values[modelReference] ?? {};
  }
  const unqualified = modelReference.includes("/")
    ? modelReference.slice(modelReference.indexOf("/") + 1)
    : modelReference;
  return Object.prototype.hasOwnProperty.call(values, unqualified)
    ? (values[unqualified] ?? {})
    : {};
}

export function applySelectionPolicyToModels(
  models: AgentModelDefinition[],
  policy: AgentProviderSelectionPolicy | undefined,
): AgentModelDefinition[] {
  if (!policy) return models;

  const decoratedModels: AgentModelDefinition[] = [];
  for (const model of models) {
    const isDefault = policy.defaultModelId
      ? modelReferences(model).includes(policy.defaultModelId)
      : model.isDefault;
    const requestedThinkingDefault = findPolicyValue(policy.thinkingDefaultsByModel, model);
    const supportsThinkingDefault =
      requestedThinkingDefault !== undefined &&
      (model.thinkingOptions?.some((option) => option.id === requestedThinkingDefault) ?? false);
    const defaultThinkingOptionId = supportsThinkingDefault
      ? requestedThinkingDefault
      : model.defaultThinkingOptionId;
    const thinkingOptions = supportsThinkingDefault
      ? model.thinkingOptions?.map((option) => ({
          ...option,
          isDefault: option.id === requestedThinkingDefault,
        }))
      : model.thinkingOptions;

    decoratedModels.push({
      ...model,
      ...(policy.defaultModelId ? { isDefault } : {}),
      ...(thinkingOptions ? { thinkingOptions } : {}),
      ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
    });
  }
  return decoratedModels;
}
