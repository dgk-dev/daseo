import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { parsePcm16MonoWav } from "../src/server/speech/audio.js";
import { resolvePaseoHome } from "../src/server/paseo-home.js";
import { DEFAULT_AZURE_STT_MODEL } from "../src/server/speech/providers/azure/config.js";
import { isAzureSpeechRegion } from "../src/server/speech/providers/azure/region.js";
import { AzureSTT } from "../src/server/speech/providers/azure/stt.js";

// Daseo delta 64: one real dictation round trip through the Azure provider. Credentials come from
// `--credentials <json>` (`{ "apiKey", "region" }`), else `$PASEO_HOME/config.json`
// (`providers.azureSpeech`), else `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`. `--stage <path>`
// writes the verified credentials to a 0600 file that the Daseo activation script merges into
// config.json while the daemon is stopped. Prints the transcript and the latency, never the key.
const DEFAULT_PHRASE = "오늘 오후 세 시 회의 일정을 알려줘";
const SAMPLE_RATE = 16000;
// Azure Speech subscription keys are 32 hex characters (older) or 84 characters (newer). A shorter
// value is a placeholder, such as Vercel's `[SENSITIVE]` for a Sensitive variable.
const MIN_STAGEABLE_KEY_LENGTH = 32;

interface AzureCredentials {
  apiKey: string;
  region: string;
}

function argValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : null;
}

function readCredentialFile(source: string): Partial<AzureCredentials> {
  const parsed = JSON.parse(readFileSync(source, "utf8")) as {
    apiKey?: string;
    region?: string;
    providers?: { azureSpeech?: { apiKey?: string; region?: string } };
  };
  return {
    apiKey: parsed.providers?.azureSpeech?.apiKey ?? parsed.apiKey,
    region: parsed.providers?.azureSpeech?.region ?? parsed.region,
  };
}

function readCredentials(argv: string[]): AzureCredentials {
  const explicit = argValue(argv, "--credentials");
  const configPath = path.join(resolvePaseoHome(), "config.json");
  let found: Partial<AzureCredentials> = {};
  let source = "AZURE_SPEECH_KEY / AZURE_SPEECH_REGION";
  if (explicit) {
    found = readCredentialFile(explicit);
    source = explicit;
  } else if (existsSync(configPath)) {
    found = readCredentialFile(configPath);
    source = configPath;
  }
  if (!found.apiKey && !explicit) {
    found = { apiKey: process.env.AZURE_SPEECH_KEY, region: process.env.AZURE_SPEECH_REGION };
    source = "AZURE_SPEECH_KEY / AZURE_SPEECH_REGION";
  }
  const apiKey = (found.apiKey ?? "").trim();
  const region = (found.region ?? "").trim();
  if (!apiKey || !isAzureSpeechRegion(region)) {
    throw new Error(`No usable Azure Speech key and region in ${source}`);
  }
  return { apiKey, region };
}

function synthesizeKoreanWav(phrase: string): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "azure-dictation-smoke-"));
  try {
    const wavPath = path.join(dir, "phrase.wav");
    execFileSync("say", [
      "-v",
      "Yuna",
      "-o",
      wavPath,
      "--file-format=WAVE",
      `--data-format=LEI16@${SAMPLE_RATE}`,
      phrase,
    ]);
    return readFileSync(wavPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Refuses credentials that cannot be real, so a placeholder never reaches the staging file. */
function assertStageable(credentials: AzureCredentials): void {
  if (!isAzureSpeechRegion(credentials.region)) {
    throw new Error("Not staging credentials: the region is not an Azure region name");
  }
  if (credentials.apiKey.length < MIN_STAGEABLE_KEY_LENGTH) {
    throw new Error(
      `Not staging credentials: the key is shorter than ${MIN_STAGEABLE_KEY_LENGTH} characters`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const credentials = readCredentials(argv);
  const stagePath = argValue(argv, "--stage");
  if (stagePath) {
    assertStageable(credentials);
  }
  const wavFlag = argv.indexOf("--wav");
  const wav =
    wavFlag >= 0 && argv[wavFlag + 1]
      ? readFileSync(argv[wavFlag + 1]!)
      : synthesizeKoreanWav(DEFAULT_PHRASE);
  const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(`Expected a ${SAMPLE_RATE} Hz WAV, got ${sampleRate} Hz`);
  }

  const logger = pino({ level: "silent" });
  const provider = new AzureSTT({ ...credentials, model: DEFAULT_AZURE_STT_MODEL }, logger);
  const session = provider.createSession({ logger, language: "ko" });
  await session.connect();
  session.appendPcm16(pcm16);
  const startedAt = Date.now();
  const transcript = await new Promise<string>((resolve, reject) => {
    session.on("transcript", (event) => resolve(event.transcript));
    session.on("error", reject);
    session.commit();
  });
  process.stdout.write(
    `audioSeconds: ${(pcm16.length / 2 / SAMPLE_RATE).toFixed(2)}\nlatencyMs: ${Date.now() - startedAt}\ntranscript: ${transcript}\n`,
  );
  if (stagePath) {
    assertStageable(credentials);
    if (!transcript.trim()) {
      throw new Error("Not staging credentials: the round trip returned no transcript");
    }
    writeFileSync(stagePath, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
    chmodSync(stagePath, 0o600);
    process.stdout.write(`staged: ${stagePath}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
