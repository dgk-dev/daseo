import type { Logger } from "pino";

import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { SpeechServices } from "../openai/runtime.js";
import type { AzureSpeechProviderConfig } from "./config.js";
import { AzureSTT } from "./stt.js";

function isAzureDictationRequested(providers: RequestedSpeechProviders): boolean {
  return providers.dictationStt.enabled !== false && providers.dictationStt.provider === "azure";
}

export function validateAzureCredentialRequirements(params: {
  providers: RequestedSpeechProviders;
  azureConfig: AzureSpeechProviderConfig | undefined;
  logger: Logger;
}): void {
  if (!isAzureDictationRequested(params.providers) || params.azureConfig) {
    return;
  }
  params.logger.warn(
    { requestedProviders: { dictationStt: "azure" }, missing: "providers.azureSpeech" },
    "Invalid speech configuration: Azure dictation selected but the key or region is missing — dictation will be unavailable",
  );
}

export function initializeAzureSpeechServices(params: {
  providers: RequestedSpeechProviders;
  azureConfig: AzureSpeechProviderConfig | undefined;
  existing: SpeechServices;
  logger: Logger;
}): SpeechServices {
  const { providers, azureConfig, existing, logger } = params;
  if (existing.dictationSttService || !azureConfig || !isAzureDictationRequested(providers)) {
    return existing;
  }
  return { ...existing, dictationSttService: new AzureSTT(azureConfig, logger) };
}
