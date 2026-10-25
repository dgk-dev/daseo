import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ClientDebugCollectPayload,
  ClientDebugCollectRequest,
} from "@getpaseo/protocol/messages";
import { resolveAppVersion } from "@/utils/app-version";
import { readDebugLog } from "./debug-log-buffer";

// Daseo delta 68: answers the daemon's `client.debug.collect.request` (the `phone_logs` agent
// tool) with this app's own logs. The reply travels the app's own connection, relay included,
// as one message: about 600 KB of text at most (newest kept), small for mobile data and far
// under the 32 MiB relay frame even after encryption and base64.

interface DaseoDebugModule {
  collectLogcat(maxLines: number, maxChars: number): Promise<string>;
  collectExitInfo(maxTraceChars: number): Promise<
    Array<{
      at: number;
      reason: string;
      processName?: string | null;
      description?: string | null;
      trace?: string | null;
    }>
  >;
}

const debugModule = requireOptionalNativeModule<DaseoDebugModule>("DaseoDebug");

const DEFAULT_CONSOLE_ENTRIES = 2000;
const DEFAULT_LOGCAT_LINES = 3000;
const CONSOLE_BUDGET_CHARS = 200_000;
const LOGCAT_BUDGET_CHARS = 350_000;
const TRACE_BUDGET_CHARS = 40_000;

function trimConsoleToBudget(entries: ReturnType<typeof readDebugLog>): {
  entries: ReturnType<typeof readDebugLog>;
  dropped: number;
} {
  let total = 0;
  let start = entries.length;
  while (start > 0) {
    const next = total + (entries[start - 1]?.message.length ?? 0) + 32;
    if (next > CONSOLE_BUDGET_CHARS) break;
    total = next;
    start -= 1;
  }
  return { entries: entries.slice(start), dropped: start };
}

export async function collectClientDebug(
  request: ClientDebugCollectRequest,
): Promise<ClientDebugCollectPayload> {
  const notes: string[] = [];
  const consoleRead = trimConsoleToBudget(
    readDebugLog(request.maxConsoleEntries ?? DEFAULT_CONSOLE_ENTRIES),
  );
  if (consoleRead.dropped > 0) {
    notes.push(`${consoleRead.dropped} older console entries left out to fit the size cap`);
  }
  let logcat: string | undefined;
  let exitInfo: ClientDebugCollectPayload["exitInfo"];
  if (Platform.OS === "android" && debugModule) {
    const maxLines = request.maxLogcatLines ?? DEFAULT_LOGCAT_LINES;
    if (maxLines > 0) {
      try {
        logcat = await debugModule.collectLogcat(maxLines, LOGCAT_BUDGET_CHARS);
      } catch (error) {
        notes.push(`logcat failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (request.includeExitInfo !== false) {
      try {
        exitInfo = (await debugModule.collectExitInfo(TRACE_BUDGET_CHARS)).map((exit) => {
          const record: NonNullable<ClientDebugCollectPayload["exitInfo"]>[number] = {
            at: exit.at,
            reason: exit.reason.slice(0, 64),
          };
          if (exit.processName) record.processName = exit.processName.slice(0, 256);
          if (exit.description) record.description = exit.description.slice(0, 2000);
          if (exit.trace) record.trace = exit.trace;
          return record;
        });
      } catch (error) {
        notes.push(`exit info failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (Platform.OS === "android") {
    notes.push("native log module missing in this build");
  } else {
    notes.push(`native logs are not collected on ${Platform.OS}`);
  }
  const appVersion = resolveAppVersion();
  return {
    requestId: request.requestId,
    platform: Platform.OS,
    ...(appVersion ? { appVersion: appVersion.slice(0, 64) } : {}),
    collectedAt: Date.now(),
    console: consoleRead.entries.map((entry) => ({
      at: entry.at,
      level: entry.level.slice(0, 16),
      message: entry.message.slice(0, 4000),
    })),
    ...(logcat !== undefined ? { logcat } : {}),
    ...(exitInfo && exitInfo.length > 0 ? { exitInfo: exitInfo.slice(0, 10) } : {}),
    ...(notes.length > 0 ? { notes: notes.slice(0, 20).map((note) => note.slice(0, 500)) } : {}),
  };
}

async function respondWithClientDebug(
  client: DaemonClient,
  request: ClientDebugCollectRequest,
): Promise<void> {
  try {
    const payload = await collectClientDebug(request);
    client.sendClientDebugCollectResponse({ type: "client.debug.collect.response", payload });
  } catch (error) {
    console.warn("[debug-collect] could not collect or send the logs", error);
  }
}

/** Subscribes one daemon connection; returns the unsubscribe. */
export function mountClientDebugResponder(client: DaemonClient): () => void {
  return client.on("client.debug.collect.request", (message) => {
    void respondWithClientDebug(client, message);
  });
}

/** The hello capability value, advertised by native apps only. */
export function clientDebugCapability(): { platform: string } | null {
  return Platform.OS === "android" || Platform.OS === "ios" ? { platform: Platform.OS } : null;
}
