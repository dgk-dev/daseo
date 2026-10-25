import type { BrowserAutomationDialogEvent } from "@getpaseo/protocol/browser-automation/rpc-schemas";

export const MAX_DIALOGS_PER_COMMAND = 20;

export interface JavaScriptDialogOpening {
  type?: unknown;
  message?: unknown;
  defaultPrompt?: unknown;
}

interface DialogPolicy {
  readonly action: BrowserAutomationDialogEvent["action"];
  readonly accept: boolean;
}

const DIALOG_POLICIES: Record<BrowserAutomationDialogEvent["type"], DialogPolicy> = {
  alert: { action: "accepted", accept: true },
  confirm: { action: "dismissed", accept: false },
  prompt: { action: "dismissed", accept: false },
  beforeunload: { action: "dismissed", accept: false },
};

export function handledDialogEvent(opening: JavaScriptDialogOpening): BrowserAutomationDialogEvent {
  const type = normalizeDialogType(opening.type);
  const policy = DIALOG_POLICIES[type];
  return {
    type,
    message: typeof opening.message === "string" ? opening.message : String(opening.message ?? ""),
    ...(typeof opening.defaultPrompt === "string" ? { defaultValue: opening.defaultPrompt } : {}),
    action: policy.action,
    timestamp: Date.now(),
  };
}

export function dialogAcceptValue(type: BrowserAutomationDialogEvent["type"]): boolean {
  return DIALOG_POLICIES[type].accept;
}

// During a command the page's window.prompt is replaced by a recorder that dismisses the prompt.
// Its state lives in a closure the main process reaches through the CDP object handle the install
// expression returns (evaluate it without returnByValue), so nothing is added to window and a page
// enumerating its globals finds no trace of the automation.
export const PROMPT_SHIM_OBJECT_GROUP = "paseo-prompt-shim";

export function promptShimInstallScript(): string {
  return String.raw`(() => {
    const prompts = [];
    const originalPrompt = window.prompt;
    const promptShim = (message = "", defaultValue = "") => {
      prompts.push({
        type: "prompt",
        message: String(message ?? ""),
        defaultValue: String(defaultValue ?? ""),
        action: "dismissed",
        timestamp: Date.now(),
      });
      return null;
    };
    window.prompt = promptShim;
    return {
      installed: () => window.prompt === promptShim,
      drain: () => prompts.splice(0),
      restore: () => {
        if (window.prompt === promptShim) window.prompt = originalPrompt;
        return true;
      },
    };
  })()`;
}

/** `Runtime.callFunctionOn` declarations, called on the handle the install expression returns. */
export const PROMPT_SHIM_INSTALLED_FUNCTION = "function () { return this.installed(); }";
export const PROMPT_SHIM_DRAIN_FUNCTION = "function () { return this.drain(); }";
export const PROMPT_SHIM_RESTORE_FUNCTION = "function () { return this.restore(); }";

function normalizeDialogType(value: unknown): BrowserAutomationDialogEvent["type"] {
  return value === "alert" || value === "confirm" || value === "prompt" || value === "beforeunload"
    ? value
    : "alert";
}
