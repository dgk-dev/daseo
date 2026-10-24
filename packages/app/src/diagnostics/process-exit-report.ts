import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { recordClientDiagnostic } from "./client-diagnostics";

// Daseo delta 63: the Android side writes the previous process's exit reasons (a native crash,
// a low-memory kill, an ANR) to this file, because none of those reach JavaScript. The app
// reports them into daemon.log on its next start and removes the file.
const EXIT_REASONS_FILE = "daseo-exit-reasons.json";
// Exits the owner caused or Android performs routinely; everything else is worth a row.
const QUIET_REASONS = new Set(["user_requested", "user_stopped", "exit_self", "permission_change"]);

interface RecordedExit {
  timestamp?: number;
  reason?: string;
  status?: number;
  importance?: number;
  pss?: number;
  rss?: number;
  description?: string;
}

export async function reportPreviousProcessExits(): Promise<void> {
  if (Platform.OS !== "android") {
    return;
  }
  try {
    const file = new File(Paths.document, EXIT_REASONS_FILE);
    if (!file.exists) {
      return;
    }
    const parsed = JSON.parse(await file.text()) as { exits?: RecordedExit[] };
    for (const exit of parsed.exits ?? []) {
      const reason = exit.reason ?? "unknown";
      if (QUIET_REASONS.has(reason)) {
        continue;
      }
      const at = typeof exit.timestamp === "number" ? new Date(exit.timestamp).toISOString() : "?";
      recordClientDiagnostic({
        level:
          reason === "low_memory" || reason.startsWith("crash") || reason === "anr"
            ? "error"
            : "warn",
        scope: "process-exit",
        message: `previous process ended: ${reason} at ${at}`,
        detail: [
          exit.description ? `description: ${exit.description}` : null,
          typeof exit.status === "number" ? `status: ${exit.status}` : null,
          typeof exit.pss === "number" ? `pss: ${Math.round(exit.pss / 1024)} MB` : null,
          typeof exit.rss === "number" ? `rss: ${Math.round(exit.rss / 1024)} MB` : null,
          typeof exit.importance === "number" ? `importance: ${exit.importance}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      });
    }
    file.delete();
  } catch (error) {
    recordClientDiagnostic({
      level: "warn",
      scope: "process-exit",
      message: `could not read previous exit reasons: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
