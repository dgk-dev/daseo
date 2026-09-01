import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentFeature, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { FormPreferences } from "@/hooks/use-form-preferences";
import { mergeProviderPreferences } from "@/hooks/use-form-preferences";
import { applyAcknowledgedFeatureMutation } from "./acknowledged-feature-mutation";

type UpdatePreferences = (
  updates: (current: FormPreferences) => FormPreferences,
) => Promise<FormPreferences>;

interface FeatureMutationClient {
  setAgentFeature(agentId: string, featureId: string, value: unknown): Promise<unknown>;
}

async function persistModelFeaturePreference(input: {
  updatePreferences: UpdatePreferences;
  provider: AgentProvider;
  modelId: string | null | undefined;
  featureId: string;
  value: unknown;
}): Promise<void> {
  if (!input.modelId) return;
  await input.updatePreferences((current) =>
    mergeProviderPreferences({
      preferences: current,
      provider: input.provider,
      updates: {
        featureValuesByModel: {
          [input.modelId!]: { [input.featureId]: input.value },
        },
      },
    }),
  );
}

async function commitFeatureMutation(input: {
  client: FeatureMutationClient;
  agentId: string;
  provider: AgentProvider;
  modelId: string | null | undefined;
  featureId: string;
  value: unknown;
  updatePreferences: UpdatePreferences;
  onError: (error: unknown) => void;
  clearPending: () => void;
}): Promise<void> {
  let runtimeAccepted = false;
  try {
    await applyAcknowledgedFeatureMutation({
      acceptRuntimeValue: async () => {
        await input.client.setAgentFeature(input.agentId, input.featureId, input.value);
        runtimeAccepted = true;
      },
      persistPreference: () => persistModelFeaturePreference(input),
    });
  } catch (error) {
    console.warn(
      runtimeAccepted
        ? "[AgentControls] persist accepted feature preference failed"
        : "[AgentControls] setAgentFeature failed",
      error,
    );
    input.onError(error);
  } finally {
    input.clearPending();
  }
}

export function useAcknowledgedAgentFeatures(input: {
  features: AgentFeature[] | undefined;
  client: FeatureMutationClient | null;
  agentId: string;
  provider: AgentProvider | null | undefined;
  modelId: string | null | undefined;
  updatePreferences: UpdatePreferences;
  onError: (error: unknown) => void;
}): {
  displayedFeatures: AgentFeature[] | undefined;
  setFeature: (featureId: string, value: unknown) => void;
} {
  const [pendingFeatureValues, setPendingFeatureValues] = useState<Record<string, unknown>>({});
  const pendingFeatureValuesRef = useRef<Record<string, unknown>>({});

  const displayedFeatures = useMemo(
    () =>
      input.features?.map((feature) =>
        Object.prototype.hasOwnProperty.call(pendingFeatureValues, feature.id)
          ? ({ ...feature, value: pendingFeatureValues[feature.id] } as AgentFeature)
          : feature,
      ),
    [input.features, pendingFeatureValues],
  );

  useEffect(() => {
    pendingFeatureValuesRef.current = {};
    setPendingFeatureValues({});
  }, [input.modelId, input.provider]);

  const clearPending = useCallback((featureId: string) => {
    const next = { ...pendingFeatureValuesRef.current };
    delete next[featureId];
    pendingFeatureValuesRef.current = next;
    setPendingFeatureValues(next);
  }, []);

  const setFeature = useCallback(
    (featureId: string, value: unknown) => {
      if (
        !input.client ||
        !input.provider ||
        Object.prototype.hasOwnProperty.call(pendingFeatureValuesRef.current, featureId)
      ) {
        return;
      }

      pendingFeatureValuesRef.current = {
        ...pendingFeatureValuesRef.current,
        [featureId]: value,
      };
      setPendingFeatureValues(pendingFeatureValuesRef.current);
      void commitFeatureMutation({
        client: input.client,
        agentId: input.agentId,
        provider: input.provider,
        modelId: input.modelId,
        featureId,
        value,
        updatePreferences: input.updatePreferences,
        onError: input.onError,
        clearPending: () => clearPending(featureId),
      });
    },
    [clearPending, input],
  );

  return { displayedFeatures, setFeature };
}
