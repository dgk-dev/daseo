import { EventEmitter } from "node:events";
import type pino from "pino";
import { v4 } from "uuid";
import { z } from "zod";

import type { SpeechToTextProvider, StreamingTranscriptionSession } from "../../speech-provider.js";
import type { AzureSpeechProviderConfig } from "./config.js";

export const AZURE_SPEECH_API_VERSION = "2025-10-15";
// The daemon resamples dictation audio to this rate before it reaches the session.
const AZURE_STT_SAMPLE_RATE = 16000;
// Dictation segments are at most the auto-commit window (15 s); fast transcription answers a
// segment that short in about a second, so 30 s only trips on a stalled connection.
const AZURE_TRANSCRIBE_TIMEOUT_MS = 30_000;

const AzureTranscribeResponseSchema = z.object({
  combinedPhrases: z.array(z.object({ text: z.string() })).optional(),
  phrases: z.array(z.object({ text: z.string() })).optional(),
});

const AzureErrorBodySchema = z.object({
  error: z.object({
    code: z.string().optional(),
    innerError: z.object({ code: z.string().optional() }).optional(),
  }),
});

export class AzureTranscriptionError extends Error {
  constructor(
    public readonly status: number,
    public readonly providerCode: string | null,
  ) {
    super(
      status === 0
        ? "Azure Speech transcription failed: request did not complete"
        : `Azure Speech transcription failed: HTTP ${status}${providerCode ? ` (${providerCode})` : ""}`,
    );
    this.name = "AzureTranscriptionError";
  }
}

export function buildAzureTranscribeUrl(region: string): string {
  return `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=${AZURE_SPEECH_API_VERSION}`;
}

/** The `definition` form field: one locale, MAI-Transcribe through enhanced mode. */
export function buildAzureTranscribeDefinition(params: { language: string; model: string }): {
  locales: string[];
  enhancedMode: { enabled: true; model: string };
} {
  return {
    locales: [params.language],
    enhancedMode: { enabled: true, model: params.model },
  };
}

/** Joined transcript text: the service's combined phrase when present, otherwise every phrase. */
export function readAzureTranscript(body: unknown): string {
  const parsed = AzureTranscribeResponseSchema.parse(body);
  const combined = parsed.combinedPhrases?.map((phrase) => phrase.text.trim()).filter(Boolean);
  if (combined && combined.length > 0) {
    return combined.join(" ");
  }
  return (parsed.phrases ?? [])
    .map((phrase) => phrase.text.trim())
    .filter(Boolean)
    .join(" ");
}

export function pcm16MonoToWav(pcm16le: Buffer, sampleRate: number): Buffer<ArrayBuffer> {
  const headerSize = 44;
  const channels = 1;
  const bitsPerSample = 16;
  const wav = Buffer.alloc(headerSize + pcm16le.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm16le.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  wav.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm16le.length, 40);
  pcm16le.copy(wav, headerSize);
  return wav;
}

async function readProviderCode(response: Response): Promise<string | null> {
  try {
    const parsed = AzureErrorBodySchema.safeParse(await response.json());
    if (!parsed.success) return null;
    return parsed.data.error.innerError?.code ?? parsed.data.error.code ?? null;
  } catch {
    return null;
  }
}

/**
 * Azure Speech fast transcription (`transcriptions:transcribe`) with MAI-Transcribe. The API is
 * synchronous, so each committed dictation segment is one request and one final transcript, the
 * same shape as the OpenAI provider. The subscription key never reaches logs or error messages.
 */
export class AzureSTT implements SpeechToTextProvider {
  public readonly id = "azure" as const;
  private readonly config: AzureSpeechProviderConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    config: AzureSpeechProviderConfig,
    parentLogger: pino.Logger,
    options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? AZURE_TRANSCRIBE_TIMEOUT_MS;
    parentLogger
      .child({ module: "agent", provider: "azure", component: "stt" })
      .info({ model: config.model, region: config.region }, "STT (Azure Speech) initialized");
  }

  public createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const logger = params.logger.child({ provider: "azure", component: "stt-session" });
    const language = params.language ?? "en";
    const transcribe = this.transcribe.bind(this);

    let connected = false;
    let segmentId = v4();
    let previousSegmentId: string | null = null;
    let pcm16: Buffer = Buffer.alloc(0);

    return {
      requiredSampleRate: AZURE_STT_SAMPLE_RATE,
      async connect() {
        connected = true;
      },
      appendPcm16(chunk: Buffer) {
        if (!connected) {
          emitter.emit("error", new Error("STT session not connected"));
          return;
        }
        pcm16 = pcm16.length === 0 ? chunk : Buffer.concat([pcm16, chunk]);
      },
      commit() {
        if (!connected) {
          emitter.emit("error", new Error("STT session not connected"));
          return;
        }
        const committedId = segmentId;
        const audio = pcm16;
        emitter.emit("committed", { segmentId: committedId, previousSegmentId });
        previousSegmentId = committedId;
        segmentId = v4();
        pcm16 = Buffer.alloc(0);

        void (async () => {
          try {
            const transcript =
              audio.length === 0 ? "" : await transcribe({ audio, language, logger });
            emitter.emit("transcript", {
              segmentId: committedId,
              transcript,
              isFinal: true,
              language,
              ...(transcript ? {} : { isLowConfidence: true }),
            });
          } catch (error) {
            emitter.emit("error", error);
          }
        })();
      },
      clear() {
        pcm16 = Buffer.alloc(0);
        segmentId = v4();
      },
      close() {
        connected = false;
        pcm16 = Buffer.alloc(0);
      },
      on(event: string, handler: (...args: never[]) => void) {
        emitter.on(event, handler as (...args: unknown[]) => void);
        return undefined;
      },
    };
  }

  private async transcribe(params: {
    audio: Buffer;
    language: string;
    logger: pino.Logger;
  }): Promise<string> {
    const startedAt = Date.now();
    const form = new FormData();
    // The service reads `audio` before `definition`.
    form.append(
      "audio",
      new Blob([pcm16MonoToWav(params.audio, AZURE_STT_SAMPLE_RATE)], { type: "audio/wav" }),
      "dictation.wav",
    );
    form.append(
      "definition",
      JSON.stringify(
        buildAzureTranscribeDefinition({ language: params.language, model: this.config.model }),
      ),
    );

    let response: Response;
    try {
      response = await this.fetchImpl(buildAzureTranscribeUrl(this.config.region), {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": this.config.apiKey },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      params.logger.error(
        { err: error instanceof Error ? error.name : String(error) },
        "Azure transcription request did not complete",
      );
      throw new AzureTranscriptionError(0, null);
    }
    if (!response.ok) {
      const providerCode = await readProviderCode(response);
      params.logger.error({ status: response.status, providerCode }, "Azure transcription failed");
      throw new AzureTranscriptionError(response.status, providerCode);
    }
    const text = readAzureTranscript(await response.json());
    params.logger.debug(
      { durationMs: Date.now() - startedAt, audioBytes: params.audio.length, chars: text.length },
      "Azure transcription complete",
    );
    return text;
  }
}
