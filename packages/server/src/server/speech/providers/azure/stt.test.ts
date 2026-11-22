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

  test("sends a segment once more when the connection drops before an answer", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(Response.json({ combinedPhrases: [{ text: "다시 보냄" }] }));
    const provider = new AzureSTT(config, logger, { fetchImpl: fetchImpl as typeof fetch });
    const session = provider.createSession({ logger, language: "ko" });
    await session.connect();
    session.appendPcm16(Buffer.alloc(320));
    const transcript = waitForEvent<StreamingTranscriptionEvent>(session, "transcript");
    session.commit();

    await expect(transcript).resolves.toMatchObject({ transcript: "다시 보냄", isFinal: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstAudio = (fetchImpl.mock.calls[0]![1] as RequestInit).body as FormData;
    const secondAudio = (fetchImpl.mock.calls[1]![1] as RequestInit).body as FormData;
    expect(secondAudio.get("audio")).toBe(firstAudio.get("audio"));
  });

  test("reports a failure after the second dropped connection", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = new AzureSTT(config, logger, { fetchImpl: fetchImpl as typeof fetch });
    const session = provider.createSession({ logger, language: "ko" });
    await session.connect();
    session.appendPcm16(Buffer.alloc(320));
    const error = waitForEvent<Error>(session, "error");
    session.commit();

    await expect(error).resolves.toMatchObject({
      message: "Azure Speech transcription failed: request did not complete",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not repeat a request that timed out", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const provider = new AzureSTT(config, logger, { fetchImpl: fetchImpl as typeof fetch });
    const session = provider.createSession({ logger, language: "ko" });
    await session.connect();
    session.appendPcm16(Buffer.alloc(320));
    const error = waitForEvent<Error>(session, "error");
    session.commit();

    await expect(error).resolves.toMatchObject({
      message: "Azure Speech transcription failed: request did not complete",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("joins phrases when the response has no combined phrase", () => {
    expect(readAzureTranscript({ phrases: [{ text: "첫 문장." }, { text: " 둘째 문장." }] })).toBe(
      "첫 문장. 둘째 문장.",
    );
    expect(readAzureTranscript({ phrases: [] })).toBe("");
    expect(buildAzureTranscribeUrl("eastus")).toContain("https://eastus.api.cognitive");
  });
});
