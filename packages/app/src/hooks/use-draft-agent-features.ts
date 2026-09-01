import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AgentProvider,
  AgentProviderSelectionPolicy,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { mergeProviderPreferences, useFormPreferences } from "./use-form-preferences";
import { getFeatureValuesForModel } from "@/create-agent-preferences/preferences";
import {
  applyFeatureValues,
  pruneFeatureValues,
  resolveFeatureValues,
} from "./feature-preferences";
import { startsNewSessionsFromDefaults } from "@/provider-selection/provider-selection-policy";

type DraftFeatureConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId"
>;

export function useDraftAgentFeatures(input: {
  serverId: string | null | undefined;
  provider: AgentProvider | null;
  cwd: string | null | undefined;
  modeId: string | null | undefined;
  modelId: string | null | undefined;
  thinkingOptionId: string | null | undefined;
  initialFeatureValues?: Record<string, unknown>;
  selectionPolicy?: AgentProviderSelectionPolicy;
}) {
  const { t } = useTranslation();
  const {
    serverId,
    provider,
    cwd,
    modeId,
    modelId,
    thinkingOptionId,
    initialFeatureValues,
    selectionPolicy,
  } = input;
  const normalizedModelId = modelId?.trim() ?? "";
  const [localFeatureValuesByModel, setLocalFeatureValuesByModel] = useState<
    Record<string, Record<string, unknown>>
  >(() =>
    normalizedModelId && initialFeatureValues ? { [normalizedModelId]: initialFeatureValues } : {},
  );
  const pendingInitialFeatureValuesRef = useRef(initialFeatureValues);
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const normalizedProvider = provider ?? null;
  const previousProviderRef = useRef<AgentProvider | null>(normalizedProvider);
  const localFeatureValues = useMemo(
    () => localFeatureValuesByModel[normalizedModelId] ?? {},
    [localFeatureValuesByModel, normalizedModelId],
  );
  const persistedFeatureValues = useMemo(() => {
    if (!provider || !normalizedModelId) return {};
    if (startsNewSessionsFromDefaults(selectionPolicy)) {
      return selectionPolicy?.featureDefaultsByModel?.[normalizedModelId] ?? {};
    }
    return getFeatureValuesForModel(preferences.providerPreferences?.[provider], normalizedModelId);
  }, [normalizedModelId, preferences.providerPreferences, provider, selectionPolicy]);

  const draftConfig = useMemo<DraftFeatureConfig | null>(() => {
    if (!normalizedProvider || !normalizedCwd) {
      return null;
    }

    return {
      provider: normalizedProvider,
      cwd: normalizedCwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }, [modeId, modelId, normalizedCwd, normalizedProvider, thinkingOptionId]);

  const featuresQuery = useQuery({
    queryKey: [
      "providerFeatures",
      serverId ?? null,
      normalizedProvider,
      normalizedCwd || null,
      modeId ?? null,
      modelId ?? null,
      thinkingOptionId ?? null,
    ],
    enabled: Boolean(serverId && client && isConnected && draftConfig),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client || !draftConfig) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listProviderFeatures(draftConfig);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? [];
    },
  });
  const availableFeaturesRaw = featuresQuery.data;
  const availableFeatures = useMemo(() => availableFeaturesRaw ?? [], [availableFeaturesRaw]);
  const featureValues = useMemo(
    () =>
      resolveFeatureValues({
        features: availableFeatures,
        persistedFeatureValues,
        localFeatureValues,
      }),
    [availableFeatures, localFeatureValues, persistedFeatureValues],
  );

  const features = useMemo(() => {
    return applyFeatureValues(availableFeatures, featureValues);
  }, [availableFeatures, featureValues]);

  useEffect(() => {
    const previousProvider = previousProviderRef.current;
    previousProviderRef.current = normalizedProvider;
    if (previousProvider === null) {
      return;
    }
    if (previousProvider !== normalizedProvider) {
      setLocalFeatureValuesByModel({});
      pendingInitialFeatureValuesRef.current = undefined;
    }
  }, [normalizedProvider]);

  useEffect(() => {
    const initialValues = pendingInitialFeatureValuesRef.current;
    if (!normalizedModelId || !initialValues) return;
    setLocalFeatureValuesByModel((current) => {
      if (current[normalizedModelId]) return current;
      return { ...current, [normalizedModelId]: initialValues };
    });
    pendingInitialFeatureValuesRef.current = undefined;
  }, [normalizedModelId]);

  useEffect(() => {
    if (availableFeaturesRaw === undefined || !normalizedModelId) {
      return;
    }
    const next = pruneFeatureValues(localFeatureValues, availableFeatures);
    if (next !== localFeatureValues) {
      setLocalFeatureValuesByModel((current) => ({
        ...current,
        [normalizedModelId]: next,
      }));
    }
  }, [availableFeatures, availableFeaturesRaw, localFeatureValues, normalizedModelId]);

  const effectiveFeatureValues = Object.keys(featureValues).length > 0 ? featureValues : undefined;
  const setFeatureValue = useCallback(
    (featureId: string, value: unknown) => {
      if (!normalizedModelId) return;
      setLocalFeatureValuesByModel((current) => {
        const currentModelValues = current[normalizedModelId] ?? {};
        if (Object.is(currentModelValues[featureId], value)) {
          return current;
        }
        return {
          ...current,
          [normalizedModelId]: { ...currentModelValues, [featureId]: value },
        };
      });
      if (!provider) return;
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider,
          updates: {
            featureValuesByModel: {
              [normalizedModelId]: { [featureId]: value },
            },
          },
        }),
      ).catch((error) => {
        console.warn("[useDraftAgentFeatures] persist feature preference failed", error);
      });
    },
    [normalizedModelId, provider, updatePreferences],
  );

  const applyProfileFeatureValues = useCallback(
    (values: Record<string, unknown>) => {
      if (!normalizedModelId) return;
      setLocalFeatureValuesByModel((current) => ({
        ...current,
        [normalizedModelId]: values,
      }));
    },
    [normalizedModelId],
  );

  return {
    features,
    featureValues: effectiveFeatureValues,
    isLoading: featuresQuery.isLoading,
    setFeatureValue,
    applyProfileFeatureValues,
  };
}
