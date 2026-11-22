import { EventEmitter } from "node:events";
import https from "node:https";
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
// Key shares the client offers in its TLS ClientHello. The runtime default adds the post-quantum
// X25519MLKEM768 share, which makes the first packet about 1.8 kB; the Azure Speech front ends do
// not take it (they ask for secp384r1 again), and the office firewall in front of the Mac resets
// that oversized ClientHello about half the time (measured 2026-11-22: 4 of 8 requests reset
// before the handshake from the office, 0 of 4 from another network, 0 with these curves).
const AZURE_TLS_ECDH_CURVES = "X25519:P-256:P-384";

const azureAgent = new https.Agent({ keepAlive: true, ecdhCurve: AZURE_TLS_ECDH_CURVES });

/**
 * The default request path: the same contract as `fetch`, sent through an agent that offers only
 * classic key shares. The multipart body and its boundary come from `Request`, so callers keep
 * building a normal `FormData`.
 */
export async function azureSpeechFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const body = Buffer.from(await request.arrayBuffer());
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers["content-length"] = String(body.length);
  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      request.url,
      { method: request.method, headers, agent: azureAgent, signal: init?.signal ?? undefined },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") responseHeaders.set(name, value);
            else if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

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

function readErrorCode(error: unknown): string | null {
  const candidates = [error, error instanceof Error ? error.cause : undefined];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      const code = (candidate as { code: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
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
    this.fetchImpl = options.fetchImpl ?? azureSpeechFetch;
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

    let response: Response | null = null;
    // A connection dropped before an answer (reset handshake, closed keep-alive socket) is sent
    // once more with the same audio, so the owner does not have to speak again. A timeout is not.
    for (let attempt = 1; response === null; attempt += 1) {
      try {
        response = await this.fetchImpl(buildAzureTranscribeUrl(this.config.region), {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": this.config.apiKey },
          body: form,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : String(error);
        const code = readErrorCode(error);
        const retry = attempt === 1 && name !== "TimeoutError" && name !== "AbortError";
        params.logger.error(
          { err: name, code, attempt, retry },
          "Azure transcription request did not complete",
        );
        if (!retry) {
          throw new AzureTranscriptionError(0, null);
        }
      }
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
