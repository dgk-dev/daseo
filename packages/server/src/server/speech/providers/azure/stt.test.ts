import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { StreamingTranscriptionEvent } from "../../speech-provider.js";
import { AzureSTT, buildAzureTranscribeUrl, readAzureTranscript } from "./stt.js";

const logger = pino({ level: "silent" });
const config = { apiKey: "test-key", region: "koreacentral", model: "MAI-Transcribe-2" };

function waitForEvent<T>(
  session: { on(event: string, handler: (payload: T) => void): unknown },
  event: "transcript" | "error",
): Promise<T> {
  return new Promise((resolve) => session.on(event, resolve));
}

describe("AzureSTT", () => {
  test("sends one committed segment as WAV with a Korean MAI-Transcribe definition", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        combinedPhrases: [{ text: "안녕하세요" }],
        phrases: [{ text: "안녕하세요" }],
      }),
    );
    const provider = new AzureSTT(config, logger, { fetchImpl: fetchImpl as typeof fetch });
    const session = provider.createSession({ logger, language: "ko" });
    await session.connect();
    session.appendPcm16(Buffer.alloc(3200));
    const transcript = waitForEvent<StreamingTranscriptionEvent>(session, "transcript");
    session.commit();

    await expect(transcript).resolves.toMatchObject({ transcript: "안녕하세요", isFinal: true });
    expect(session.requiredSampleRate).toBe(16000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://koreacentral.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Ocp-Apim-Subscription-Key": "test-key" });
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["audio", "definition"]);
    expect(JSON.parse(form.get("definition") as string)).toEqual({
      locales: ["ko"],
      enhancedMode: { enabled: true, model: "MAI-Transcribe-2" },
    });
    const audio = form.get("audio") as Blob;
    expect(audio.type).toBe("audio/wav");
    const wav = Buffer.from(await audio.arrayBuffer());
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.length).toBe(44 + 3200);
  });

  test("answers an empty segment with an empty final transcript and no request", async () => {
    const fetchImpl = vi.fn();
    const provider = new AzureSTT(config, logger, { fetchImpl: fetchImpl as typeof fetch });
    const session = provider.createSession({ logger, language: "ko" });
    await session.connect();
    const transcript = waitForEvent<StreamingTranscriptionEvent>(session, "transcript");
    session.commit();

    await expect(transcript).resolves.toMatchObject({ transcript: "", isFinal: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("reports an HTTP failure with status and Azure code, never the key", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: "InvalidRequest", innerError: { code: "InvalidAudioFormat" } } },
        { status: 400 },
      ),
    );
    const provider = new AzureSTT(config, logger, { fetchImpl: fetchImpl as typeof fetch });
    const session = provider.createSession({ logger, language: "ko" });
    await session.connect();
    session.appendPcm16(Buffer.alloc(320));
    const error = waitForEvent<Error>(session, "error");
    session.commit();

    const failure = await error;
    expect(failure.message).toBe(
      "Azure Speech transcription failed: HTTP 400 (InvalidAudioFormat)",
    );
    expect(failure.message).not.toContain("test-key");
  });

  test("joins phrases when the response has no combined phrase", () => {
    expect(readAzureTranscript({ phrases: [{ text: "첫 문장." }, { text: " 둘째 문장." }] })).toBe(
      "첫 문장. 둘째 문장.",
    );
    expect(readAzureTranscript({ phrases: [] })).toBe("");
    expect(buildAzureTranscribeUrl("eastus")).toContain("https://eastus.api.cognitive");
  });
});
