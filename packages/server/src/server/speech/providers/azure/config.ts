import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import { isAzureSpeechRegion } from "./region.js";

export const DEFAULT_AZURE_STT_MODEL = "MAI-Transcribe-2";

export interface AzureSpeechProviderConfig {
  apiKey: string;
  region: string;
  model: string;
}

function firstNonEmptyString(values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Azure Speech serves dictation only. The config is resolved when dictation selects it, from
 * `providers.azureSpeech` first and `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` second, the same
 * persisted-before-env order the OpenAI provider uses. A missing key or region leaves it
 * unresolved; the speech runtime then reports dictation as unavailable and logs why.
 */
export function resolveAzureSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): AzureSpeechProviderConfig | undefined {
  const { env, persisted, providers } = params;
  if (providers.dictationStt.enabled === false || providers.dictationStt.provider !== "azure") {
    return undefined;
  }
  const azure = persisted.providers?.azureSpeech;
  const apiKey = firstNonEmptyString([azure?.apiKey, env.AZURE_SPEECH_KEY]);
  const region = firstNonEmptyString([azure?.region, env.AZURE_SPEECH_REGION]);
  if (!apiKey || !region) {
    return undefined;
  }
  if (!isAzureSpeechRegion(region)) {
    throw new Error(`Invalid Azure Speech region "${region}"`);
  }
  return {
    apiKey,
    region,
    model:
      firstNonEmptyString([persisted.features?.dictation?.stt?.model]) ?? DEFAULT_AZURE_STT_MODEL,
  };
}
