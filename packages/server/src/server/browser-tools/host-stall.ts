import { execFile } from "node:child_process";
import type pino from "pino";
import type { PushPayload } from "../push/index.js";

// Daseo delta 92. After the 0.5.105 swap a macOS keychain prompt held the desktop app's main
// thread for 85+ minutes, and every browser tool answered only "did not respond within
// 15000ms". The broker now names the likely cause in the tool result and tells the owner's
// phone once per stall.

/** Resolves true when a macOS security prompt (SecurityAgent) is on screen. */
export type SecurityPromptProbe = () => Promise<boolean>;

const SECURITY_PROMPT_CACHE_MS = 3_000;
const PGREP_TIMEOUT_MS = 1_000;

/**
 * `pgrep -x SecurityAgent`, cached a few seconds so a burst of timed-out tool calls runs it once.
 * macOS starts SecurityAgent to show keychain and authorization prompts. Off macOS it is always
 * false.
 */
export function createMacSecurityPromptProbe(
  options: {
    platform?: NodeJS.Platform;
    isRunning?: () => Promise<boolean>;
    now?: () => number;
    cacheMs?: number;
  } = {},
): SecurityPromptProbe {
  if ((options.platform ?? process.platform) !== "darwin") {
    return async () => false;
  }
  const isRunning = options.isRunning ?? isSecurityAgentRunning;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? SECURITY_PROMPT_CACHE_MS;
  let cached: { at: number; value: Promise<boolean> } | null = null;
  return () => {
    const at = now();
    if (!cached || at - cached.at >= cacheMs) {
      cached = { at, value: isRunning().catch(() => false) };
    }
    return cached.value;
  };
}

function isSecurityAgentRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", "SecurityAgent"], { timeout: PGREP_TIMEOUT_MS }, (error) => {
      // pgrep exits 0 when a process matched and 1 when none did.
      resolve(!error);
    });
  });
}

export interface BrowserHostStall {
  /** A macOS security prompt was on screen when the stall was seen. */
  securityPrompt: boolean;
}

/** What the broker tells when a browser host stalls and when it answers again. */
export interface BrowserHostStallListener {
  stalled(stall: BrowserHostStall): void;
  answered(): void;
}

export const BROWSER_HOST_STALL_PUSH_REPEAT_MS = 30 * 60_000;

/**
 * One push per stall episode: a stall right after another one is the same episode until a
 * browser command is answered again, and a stall that never ends is repeated only after
 * `repeatAfterMs`.
 */
export class BrowserHostStallPushNotifier implements BrowserHostStallListener {
  private notifiedAt: number | null = null;
  private readonly now: () => number;
  private readonly repeatAfterMs: number;

  public constructor(
    private readonly options: {
      serverId: string;
      send: (payload: PushPayload) => Promise<void>;
      logger?: pino.Logger;
      now?: () => number;
      repeatAfterMs?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.repeatAfterMs = options.repeatAfterMs ?? BROWSER_HOST_STALL_PUSH_REPEAT_MS;
  }

  public stalled(stall: BrowserHostStall): void {
    const at = this.now();
    if (this.notifiedAt !== null && at - this.notifiedAt < this.repeatAfterMs) {
      return;
    }
    this.notifiedAt = at;
    this.options.logger?.warn(
      { securityPrompt: stall.securityPrompt },
      "Browser host stalled; sending push notification",
    );
    void this.options
      .send({
        title: "Daseo",
        body: stall.securityPrompt
          ? "Mac의 Daseo가 macOS 확인 창 때문에 멈췄습니다. Mac에서 창을 확인해 주세요."
          : "Mac의 Daseo 앱이 응답하지 않아 브라우저 도구가 멈췄습니다. Mac 화면을 확인해 주세요.",
        data: { serverId: this.options.serverId },
      })
      .catch((error: unknown) => {
        this.options.logger?.warn({ err: error }, "Failed to send browser stall push");
      });
  }

  public answered(): void {
    this.notifiedAt = null;
  }
}
