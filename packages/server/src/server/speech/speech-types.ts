import { z } from "zod";

// `azure` serves dictation only (Daseo delta 64); voice mode keeps `openai | local`.
export const SpeechProviderIdSchema = z.enum(["openai", "local", "azure"]);
export const VoiceSpeechProviderIdSchema = z.enum(["openai", "local"]);
export type SpeechProviderId = z.infer<typeof SpeechProviderIdSchema>;

export const RequestedSpeechProviderSchema = z.object({
  provider: SpeechProviderIdSchema,
  explicit: z.boolean(),
  enabled: z.boolean().optional(),
});
export type RequestedSpeechProvider = z.infer<typeof RequestedSpeechProviderSchema>;

export interface RequestedSpeechProviders {
  dictationStt: RequestedSpeechProvider;
  voiceTurnDetection: RequestedSpeechProvider;
  voiceStt: RequestedSpeechProvider;
  voiceTts: RequestedSpeechProvider;
}
