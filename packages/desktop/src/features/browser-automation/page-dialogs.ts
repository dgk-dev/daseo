// Daseo delta 93. Who answers a page's alert, confirm, or prompt, and when.
//
// Electron answers page dialogs with a native macOS message box parented to the owner window (a
// sheet over the whole Daseo window). Daseo takes the dialog over at its source instead
// (page-dialog-hook.ts) and this controller is the single owner of each tab's dialogs: exactly one
// decision per dialog, made here, and nothing native is ever shown.
//
// - alert: answered at once when an agent is involved (a command is running, or an agent used the
//   tab within the agent-driven window); otherwise shown to a person in the tab's pane.
// - confirm, prompt: answered at once only when the running command pre-armed an answer. With an
//   agent involved the dialog is held open for browser_handle_dialog and dismissed after
//   PAGE_DIALOG_AGENT_HOLD_MS; a person can answer it in the pane too, first answer wins. With no
//   agent involved it waits in the pane for the person.
// - No pane can show it (old renderer, unregistered tab): answered by policy, alert accepted and
//   the others dismissed.
//
// While a dialog is open the page's script thread is blocked, so there is at most one per tab.

import type {
  BrowserAutomationDialogEvent,
  BrowserAutomationOpenDialog,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";

export const MAX_DIALOGS_PER_COMMAND = 20;
/** How long a confirm or prompt an agent is involved in stays open before it is dismissed. */
export const PAGE_DIALOG_AGENT_HOLD_MS = 60_000;

export type PageDialogType = BrowserAutomationOpenDialog["type"];

export interface PageDialogPreArm {
  action: "accept" | "dismiss";
  /** Text an accepted prompt returns; the prompt's default when absent. */
  promptText?: string;
}

export interface PageDialogOpening {
  type: unknown;
  message: unknown;
  defaultValue?: unknown;
  /** URL of the frame that opened it. */
  url?: unknown;
}

/** Answers the page: `accept` is OK, `text` is what an accepted prompt returns. */
export type PageDialogResponder = (accept: boolean, text: string) => void;

export interface HeldPageDialog {
  readonly id: string;
  readonly type: PageDialogType;
  readonly message: string;
  readonly defaultValue?: string;
  readonly url?: string;
  readonly openedAt: number;
  /** Who it waits for: an agent (dismissed at `expiresAt`) or a person (no deadline). */
  readonly holder: "agent" | "person";
  readonly expiresAt?: number;
}

/** A pane that shows the tab's held dialog to a person. */
export interface PageDialogSurface {
  /** Whether a pane can show this tab's dialogs right now. */
  available(): boolean;
  show(dialog: HeldPageDialog): void;
  hide(dialogId: string): void;
}

export interface PageDialogControllerOptions {
  /** True while an agent's last command on the tab is recent (the agent-driven window). */
  wasAgentDriven(): boolean;
  surface?: PageDialogSurface;
  now?: () => number;
  agentHoldMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  createId?: () => string;
}

export type PageDialogCommandOutcome<T> =
  | { kind: "done"; result: T; dialogs: BrowserAutomationDialogEvent[] }
  | {
      kind: "held";
      dialog: HeldPageDialog;
      dialogs: BrowserAutomationDialogEvent[];
      /** The command itself, still waiting on the page; its late result has no reader. */
      settled: Promise<T>;
    };

export interface PageDialogCommandOptions {
  preArm?: PageDialogPreArm;
  /** Return as soon as a confirm or prompt is held instead of waiting for the task. */
  returnWhenHeld: boolean;
}

interface CommandScope {
  readonly dialogs: BrowserAutomationDialogEvent[];
  readonly preArm?: PageDialogPreArm;
  onHeld?: (dialog: HeldPageDialog) => void;
}

interface OpenEntry {
  dialog: HeldPageDialog;
  respond: PageDialogResponder;
  timer: unknown;
}

export class PageDialogController {
  private open: OpenEntry | null = null;
  private readonly pending: BrowserAutomationDialogEvent[] = [];
  private readonly scopes = new Set<CommandScope>();
  private readonly openingListeners = new Set<(type: PageDialogType) => void>();
  private destroyed = false;
  private nextId = 0;
  private readonly now: () => number;
  private readonly agentHoldMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  public constructor(private readonly options: PageDialogControllerOptions) {
    this.now = options.now ?? Date.now;
    this.agentHoldMs = options.agentHoldMs ?? PAGE_DIALOG_AGENT_HOLD_MS;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The dialog the page waits on, if any. */
  public current(): HeldPageDialog | null {
    return this.open?.dialog ?? null;
  }

  /**
   * Daseo delta 100: calls `listener` whenever the page opens a dialog, before it is answered, so an
   * observed click can say it opened one. Returns an unsubscribe.
   */
  public onOpening(listener: (type: PageDialogType) => void): () => void {
    this.openingListeners.add(listener);
    return () => this.openingListeners.delete(listener);
  }

  /** A page dialog opened (alert, confirm, prompt). Every call is answered exactly once. */
  public handleOpening(opening: PageDialogOpening, respond: PageDialogResponder): void {
    const type = normalizeDialogType(opening.type);
    const fields = openingFields(type, opening);
    for (const listener of this.openingListeners) listener(type);
    if (this.destroyed) {
      respond(false, "");
      return;
    }
    if (this.open) {
      // A second frame's dialog while one is held (out-of-process frames run on their own).
      this.answerByPolicy(type, fields, respond);
      return;
    }
    const agentInvolved = this.scopes.size > 0 || this.options.wasAgentDriven();
    if (type === "alert") {
      if (agentInvolved || !this.surfaceAvailable()) {
        this.answerByPolicy(type, fields, respond);
      } else {
        this.hold(type, fields, respond, "person");
      }
      return;
    }
    const preArm = this.scopes.size > 0 ? this.activePreArm() : undefined;
    if (preArm) {
      const accept = preArm.action === "accept";
      const text =
        accept && type === "prompt" ? (preArm.promptText ?? fields.defaultValue ?? "") : "";
      respond(accept, text);
      this.record(answeredEvent(type, fields, accept, text, this.now()));
      return;
    }
    if (agentInvolved) {
      this.hold(type, fields, respond, "agent");
    } else if (this.surfaceAvailable()) {
      this.hold(type, fields, respond, "person");
    } else {
      this.answerByPolicy(type, fields, respond);
    }
  }

  /**
   * The page asked to confirm leaving (beforeunload). The caller always lets it leave: an agent
   * that navigates means it, and Electron gives no way to ask a person asynchronously.
   */
  public handleBeforeUnload(): void {
    if (this.scopes.size === 0 && !this.options.wasAgentDriven()) return;
    this.record({ type: "beforeunload", message: "", action: "accepted", timestamp: this.now() });
  }

  /** Chromium dropped the page's dialogs (the document went away). */
  public handleCancel(): void {
    this.closeUnanswered("page_left");
  }

  /** An agent navigates the tab away: the held dialog is dismissed so the navigation can run. */
  public dismissForNavigation(): void {
    this.closeUnanswered("page_left", true);
  }

  /** The tab is gone; nothing more is answered or recorded. */
  public destroy(): void {
    this.destroyed = true;
    const entry = this.open;
    if (entry) {
      this.close(entry);
    }
    this.pending.length = 0;
  }

  /**
   * Answers the held dialog. `by: "agent"` returns the answer for the command's own result;
   * `by: "person"` records it for the agent when the agent was waiting on it. A `dialogId` that
   * no longer matches (already answered, or a newer dialog) answers nothing.
   */
  public answer(input: {
    accept: boolean;
    promptText?: string;
    by: "agent" | "person";
    dialogId?: string;
  }): BrowserAutomationDialogEvent | null {
    const entry = this.open;
    if (!entry || (input.dialogId !== undefined && input.dialogId !== entry.dialog.id)) {
      return null;
    }
    const { dialog } = entry;
    const accept = dialog.type === "alert" ? true : input.accept;
    const text =
      accept && dialog.type === "prompt" ? (input.promptText ?? dialog.defaultValue ?? "") : "";
    this.close(entry);
    entry.respond(accept, text);
    const event = answeredEvent(dialog.type, dialog, accept, text, this.now());
    if (input.by === "person") {
      if (dialog.holder === "agent") this.record({ ...event, reason: "person" });
      return event;
    }
    return event;
  }

  /** Answered-but-unreported dialogs, handed to the next command; the queue empties. */
  public takePending(): BrowserAutomationDialogEvent[] {
    return this.pending.splice(0);
  }

  /**
   * A command that needs the page arrived while a confirm or prompt holds it. Returns the held
   * dialog (a person's dialog now waits on the agent's deadline) and the queued answers, or null
   * when the page is free. An alert left for a person is not a reason to refuse: runCommand
   * accepts it.
   */
  public refuseCommand(): {
    dialog: HeldPageDialog;
    dialogs: BrowserAutomationDialogEvent[];
  } | null {
    if (!this.open || this.open.dialog.type === "alert") return null;
    this.claimForAgent();
    return { dialog: this.open.dialog, dialogs: this.takePending() };
  }

  /**
   * Runs an agent command on the tab. Dialogs answered while it runs are returned with its
   * result, after the ones queued since the tab's last command. An alert still waiting for a
   * person is accepted for the agent, and a confirm or prompt a person holds starts the agent
   * deadline. With `returnWhenHeld`, a confirm or prompt the command leaves open ends the wait at
   * once: the page is blocked until it is answered, so the command could not finish anyway.
   */
  public async runCommand<T>(
    options: PageDialogCommandOptions,
    task: () => Promise<T>,
  ): Promise<PageDialogCommandOutcome<T>> {
    const scope: CommandScope = {
      dialogs: this.takePending(),
      ...(options.preArm ? { preArm: options.preArm } : {}),
    };
    this.scopes.add(scope);
    try {
      this.claimForAgent();
      let resolveHeld: (dialog: HeldPageDialog) => void = () => {};
      const held = new Promise<HeldPageDialog>((resolve) => {
        resolveHeld = resolve;
      });
      if (options.returnWhenHeld) {
        scope.onHeld = resolveHeld;
        if (this.open) resolveHeld(this.open.dialog);
      }
      const work = task();
      const first = await Promise.race([
        work.then((result) => ({ kind: "done" as const, result })),
        held.then((dialog) => ({ kind: "held" as const, dialog })),
      ]);
      if (first.kind === "done") {
        return { kind: "done", result: first.result, dialogs: scope.dialogs };
      }
      // The command keeps running in the page once the dialog is answered; nobody reads it.
      work.catch(() => {});
      return { kind: "held", dialog: first.dialog, dialogs: scope.dialogs, settled: work };
    } finally {
      this.scopes.delete(scope);
    }
  }

  private claimForAgent(): void {
    const entry = this.open;
    if (!entry) return;
    if (entry.dialog.type === "alert") {
      const event = this.answer({ accept: true, by: "agent", dialogId: entry.dialog.id });
      if (event) this.record(event);
      return;
    }
    if (entry.dialog.holder === "person") {
      const expiresAt = this.now() + this.agentHoldMs;
      entry.dialog = { ...entry.dialog, holder: "agent", expiresAt };
      entry.timer = this.setTimer(() => this.expire(entry), this.agentHoldMs);
      if (this.surfaceAvailable()) this.options.surface?.show(entry.dialog);
    }
  }

  private hold(
    type: PageDialogType,
    fields: DialogFields,
    respond: PageDialogResponder,
    holder: HeldPageDialog["holder"],
  ): void {
    const openedAt = this.now();
    const dialog: HeldPageDialog = {
      id: this.options.createId?.() ?? `dialog-${(this.nextId += 1)}`,
      type,
      message: fields.message,
      ...(fields.defaultValue !== undefined ? { defaultValue: fields.defaultValue } : {}),
      ...(fields.url !== undefined ? { url: fields.url } : {}),
      openedAt,
      holder,
      ...(holder === "agent" ? { expiresAt: openedAt + this.agentHoldMs } : {}),
    };
    const entry: OpenEntry = { dialog, respond, timer: null };
    if (holder === "agent") {
      entry.timer = this.setTimer(() => this.expire(entry), this.agentHoldMs);
    }
    this.open = entry;
    if (this.surfaceAvailable()) this.options.surface?.show(dialog);
    for (const scope of this.scopes) scope.onHeld?.(dialog);
  }

  private expire(entry: OpenEntry): void {
    if (this.open !== entry) return;
    this.close(entry);
    entry.respond(false, "");
    this.record({
      ...answeredEvent(entry.dialog.type, entry.dialog, false, "", this.now()),
      reason: "unanswered",
    });
  }

  private closeUnanswered(reason: string, byAgent = false): void {
    const entry = this.open;
    if (!entry) return;
    this.close(entry);
    // Chromium drops the answer when the frame is gone; when it is not, the page goes on.
    entry.respond(false, "");
    if (byAgent || entry.dialog.holder === "agent" || this.scopes.size > 0) {
      this.record({
        ...answeredEvent(entry.dialog.type, entry.dialog, false, "", this.now()),
        reason,
      });
    }
  }

  private close(entry: OpenEntry): void {
    if (this.open === entry) this.open = null;
    if (entry.timer !== null) {
      this.clearTimer(entry.timer);
      entry.timer = null;
    }
    this.options.surface?.hide(entry.dialog.id);
  }

  private answerByPolicy(
    type: PageDialogType,
    fields: DialogFields,
    respond: PageDialogResponder,
  ): void {
    const accept = type === "alert";
    respond(accept, "");
    this.record(answeredEvent(type, fields, accept, "", this.now()));
  }

  private activePreArm(): PageDialogPreArm | undefined {
    let preArm: PageDialogPreArm | undefined;
    for (const scope of this.scopes) preArm = scope.preArm ?? preArm;
    return preArm;
  }

  private surfaceAvailable(): boolean {
    return this.options.surface?.available() === true;
  }

  private record(event: BrowserAutomationDialogEvent): void {
    if (this.destroyed) return;
    if (this.scopes.size === 0) {
      if (this.pending.length >= MAX_DIALOGS_PER_COMMAND) this.pending.shift();
      this.pending.push(event);
      return;
    }
    for (const scope of this.scopes) {
      if (scope.dialogs.length < MAX_DIALOGS_PER_COMMAND) scope.dialogs.push(event);
    }
  }
}

interface DialogFields {
  message: string;
  defaultValue?: string;
  url?: string;
}

function openingFields(type: PageDialogType, opening: PageDialogOpening): DialogFields {
  return {
    message: typeof opening.message === "string" ? opening.message : String(opening.message ?? ""),
    ...(type === "prompt" && typeof opening.defaultValue === "string"
      ? { defaultValue: opening.defaultValue }
      : {}),
    ...(typeof opening.url === "string" && opening.url.length > 0 ? { url: opening.url } : {}),
  };
}

function answeredEvent(
  type: PageDialogType,
  fields: DialogFields,
  accept: boolean,
  text: string,
  timestamp: number,
): BrowserAutomationDialogEvent {
  return {
    type,
    message: fields.message,
    ...(fields.defaultValue !== undefined ? { defaultValue: fields.defaultValue } : {}),
    action: accept ? "accepted" : "dismissed",
    ...(type === "prompt" && accept ? { promptText: text } : {}),
    timestamp,
    ...(fields.url !== undefined ? { url: fields.url } : {}),
  };
}

function normalizeDialogType(value: unknown): PageDialogType {
  return value === "confirm" || value === "prompt" ? value : "alert";
}
