import { describe, expect, test } from "vitest";
import {
  PAGE_DIALOG_AGENT_HOLD_MS,
  PageDialogController,
  type HeldPageDialog,
  type PageDialogResponder,
  type PageDialogTrace,
} from "./page-dialogs.js";

interface Answer {
  accept: boolean;
  text: string;
}

function setup(input: { agentDriven?: boolean; surface?: boolean } = {}) {
  let now = 1_000;
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = [];
  const shown: HeldPageDialog[] = [];
  const hidden: string[] = [];
  const state = { agentDriven: input.agentDriven ?? false, surface: input.surface ?? false };
  const controller = new PageDialogController({
    wasAgentDriven: () => state.agentDriven,
    surface: {
      available: () => state.surface,
      show: (dialog) => shown.push(dialog),
      hide: (dialogId) => hidden.push(dialogId),
    },
    now: () => now,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const open = (
    type: string,
    message: string,
    extra: { defaultValue?: string; url?: string } = {},
  ): Answer[] => {
    const answers: Answer[] = [];
    const respond: PageDialogResponder = (accept, text) => answers.push({ accept, text });
    controller.handleOpening({ type, message, ...extra }, respond);
    return answers;
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (!timer.cleared && timer.at <= now) {
        timer.cleared = true;
        timer.callback();
      }
    }
  };
  return { controller, open, advance, shown, hidden, state };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("page dialog owner (delta 93)", () => {
  test("an alert during a command is accepted at once and reported with the command", async () => {
    const { controller, open } = setup();
    let answers: Answer[] = [];
    const outcome = await controller.runCommand({ returnWhenHeld: true }, async () => {
      answers = open("alert", "Saved", { url: "https://shop.example/admin" });
      return "clicked";
    });
    expect(answers).toEqual([{ accept: true, text: "" }]);
    expect(outcome).toEqual({
      kind: "done",
      result: "clicked",
      dialogs: [
        {
          type: "alert",
          message: "Saved",
          action: "accepted",
          timestamp: 1_000,
          url: "https://shop.example/admin",
        },
      ],
    });
  });

  test("a confirm during a command is held, the command returns at once, and the agent answers it", async () => {
    const { controller, open, shown } = setup({ surface: true });
    let answers: Answer[] = [];
    const outcome = await controller.runCommand({ returnWhenHeld: true }, async () => {
      answers = open("confirm", "저장하시겠습니까?");
      return never<string>();
    });
    expect(outcome).toMatchObject({
      kind: "held",
      dialog: {
        type: "confirm",
        message: "저장하시겠습니까?",
        holder: "agent",
        expiresAt: 1_000 + PAGE_DIALOG_AGENT_HOLD_MS,
      },
      dialogs: [],
    });
    // A person looking at the tab sees it too.
    expect(shown.map((dialog) => dialog.type)).toEqual(["confirm"]);
    expect(answers).toEqual([]);

    expect(controller.answer({ accept: true, by: "agent" })).toMatchObject({
      type: "confirm",
      action: "accepted",
    });
    expect(answers).toEqual([{ accept: true, text: "" }]);
    expect(controller.current()).toBeNull();
  });

  test("a dismissed confirm answers false", () => {
    const { controller, open } = setup({ agentDriven: true });
    const answers = open("confirm", "Delete?");
    expect(controller.answer({ accept: false, by: "agent" })).toMatchObject({
      action: "dismissed",
    });
    expect(answers).toEqual([{ accept: false, text: "" }]);
  });

  test("a prompt answered with text returns that text; accepted without text returns its default", () => {
    const { controller, open } = setup({ agentDriven: true });
    const first = open("prompt", "name?", { defaultValue: "Ada" });
    expect(controller.answer({ accept: true, promptText: "x", by: "agent" })).toMatchObject({
      type: "prompt",
      action: "accepted",
      promptText: "x",
      defaultValue: "Ada",
    });
    expect(first).toEqual([{ accept: true, text: "x" }]);

    const second = open("prompt", "name?", { defaultValue: "Ada" });
    controller.answer({ accept: true, by: "agent" });
    expect(second).toEqual([{ accept: true, text: "Ada" }]);
  });

  test("a pre-armed command answers its confirm and prompt at once", async () => {
    const { controller, open } = setup();
    let confirmAnswers: Answer[] = [];
    let promptAnswers: Answer[] = [];
    const outcome = await controller.runCommand(
      { returnWhenHeld: true, preArm: { action: "accept", promptText: "typed" } },
      async () => {
        confirmAnswers = open("confirm", "Save?");
        promptAnswers = open("prompt", "Name?", { defaultValue: "d" });
        return "ran";
      },
    );
    expect(confirmAnswers).toEqual([{ accept: true, text: "" }]);
    expect(promptAnswers).toEqual([{ accept: true, text: "typed" }]);
    expect(outcome).toMatchObject({
      kind: "done",
      dialogs: [
        { type: "confirm", action: "accepted" },
        { type: "prompt", action: "accepted", promptText: "typed" },
      ],
    });

    let dismissed: Answer[] = [];
    await controller.runCommand(
      { returnWhenHeld: true, preArm: { action: "dismiss" } },
      async () => {
        dismissed = open("confirm", "Delete?");
        return "ran";
      },
    );
    expect(dismissed).toEqual([{ accept: false, text: "" }]);
  });

  test("a held confirm nobody answers is dismissed after 60 s and reported on the next command", async () => {
    const { controller, open, advance, hidden } = setup({ agentDriven: true });
    const answers = open("confirm", "Leave?");
    advance(PAGE_DIALOG_AGENT_HOLD_MS - 1);
    expect(answers).toEqual([]);
    advance(1);
    expect(answers).toEqual([{ accept: false, text: "" }]);
    expect(controller.current()).toBeNull();
    expect(hidden).toHaveLength(1);

    const next = await controller.runCommand({ returnWhenHeld: true }, async () => "snapshot");
    expect(next).toMatchObject({
      kind: "done",
      dialogs: [{ type: "confirm", action: "dismissed", reason: "unanswered" }],
    });
  });

  test("an idle agent tab: alert accepted and queued, confirm held for the agent", async () => {
    const { controller, open } = setup({ agentDriven: true, surface: true });
    expect(open("alert", "Session expires soon")).toEqual([{ accept: true, text: "" }]);
    open("confirm", "Extend session?");
    expect(controller.current()).toMatchObject({ holder: "agent" });

    const refused = controller.refuseCommand();
    expect(refused).toMatchObject({
      dialog: { type: "confirm" },
      dialogs: [{ type: "alert", message: "Session expires soon", action: "accepted" }],
    });
  });

  test("a person's tab: the dialog waits in the pane with no deadline, and the person answers it", () => {
    const { controller, open, advance, shown, hidden } = setup({ surface: true });
    const alertAnswers = open("alert", "Hello");
    expect(alertAnswers).toEqual([]);
    expect(controller.current()).toMatchObject({ type: "alert", holder: "person" });
    expect(controller.current()?.expiresAt).toBeUndefined();
    advance(10 * PAGE_DIALOG_AGENT_HOLD_MS);
    expect(alertAnswers).toEqual([]);
    const dialogId = controller.current()?.id ?? "";
    expect(shown.map((dialog) => dialog.id)).toEqual([dialogId]);

    // A stale id from an earlier card answers nothing.
    expect(controller.answer({ accept: true, by: "person", dialogId: "stale" })).toBeNull();
    expect(controller.answer({ accept: true, by: "person", dialogId })).toMatchObject({
      type: "alert",
    });
    expect(alertAnswers).toEqual([{ accept: true, text: "" }]);
    expect(hidden).toEqual([dialogId]);
    // Nothing is queued for an agent that was never involved.
    expect(controller.takePending()).toEqual([]);
  });

  test("an agent command takes over what a person left: an alert is accepted, a confirm starts the agent deadline", async () => {
    const { controller, open, shown } = setup({ surface: true });
    const alertAnswers = open("alert", "Hi");
    const outcome = await controller.runCommand({ returnWhenHeld: true }, async () => "snapshot");
    expect(alertAnswers).toEqual([{ accept: true, text: "" }]);
    expect(outcome).toMatchObject({
      kind: "done",
      dialogs: [{ type: "alert", action: "accepted" }],
    });

    open("confirm", "Continue?");
    expect(controller.current()).toMatchObject({ holder: "person" });
    expect(controller.refuseCommand()?.dialog).toMatchObject({
      holder: "agent",
      expiresAt: 1_000 + PAGE_DIALOG_AGENT_HOLD_MS,
    });
    expect(shown.at(-1)).toMatchObject({ holder: "agent" });
  });

  test("a person answering an agent-held dialog is reported to the agent", () => {
    const { controller, open } = setup({ agentDriven: true, surface: true });
    open("confirm", "Publish?");
    const dialogId = controller.current()?.id ?? "";
    controller.answer({ accept: true, by: "person", dialogId });
    expect(controller.takePending()).toMatchObject([
      { type: "confirm", action: "accepted", reason: "person" },
    ]);
    // First answer wins.
    expect(controller.answer({ accept: false, by: "agent" })).toBeNull();
  });

  test("no pane and no agent: answered by policy (alert accepted, confirm and prompt dismissed)", () => {
    const { controller, open } = setup();
    expect(open("alert", "a")).toEqual([{ accept: true, text: "" }]);
    expect(open("confirm", "c")).toEqual([{ accept: false, text: "" }]);
    expect(open("prompt", "p", { defaultValue: "d" })).toEqual([{ accept: false, text: "" }]);
    expect(controller.takePending().map((event) => [event.type, event.action])).toEqual([
      ["alert", "accepted"],
      ["confirm", "dismissed"],
      ["prompt", "dismissed"],
    ]);
  });

  test("an agent navigation dismisses the held dialog first and reports it", async () => {
    const { controller, open } = setup({ agentDriven: true });
    const answers = open("confirm", "Stay?");
    const outcome = await controller.runCommand({ returnWhenHeld: false }, async () => {
      controller.dismissForNavigation();
      return "navigated";
    });
    expect(answers).toEqual([{ accept: false, text: "" }]);
    expect(outcome).toMatchObject({
      kind: "done",
      dialogs: [{ type: "confirm", action: "dismissed", reason: "page_left" }],
    });
  });

  test("Chromium cancelling the page's dialogs closes the held one", () => {
    const { controller, open, hidden } = setup({ agentDriven: true });
    const answers = open("confirm", "x");
    controller.handleCancel();
    expect(answers).toEqual([{ accept: false, text: "" }]);
    expect(controller.current()).toBeNull();
    expect(hidden).toHaveLength(1);
    expect(controller.takePending()).toMatchObject([{ reason: "page_left" }]);
  });

  test("a destroyed tab answers nothing more and records nothing", () => {
    const { controller, open, advance } = setup({ agentDriven: true });
    const answers = open("confirm", "x");
    controller.destroy();
    advance(PAGE_DIALOG_AGENT_HOLD_MS);
    expect(answers).toEqual([]);
    expect(controller.current()).toBeNull();
    expect(open("alert", "late")).toEqual([{ accept: false, text: "" }]);
    expect(controller.takePending()).toEqual([]);
  });

  test("two dialogs in a row: confirm answered, then the follow-up alert is accepted", async () => {
    const { controller, open } = setup();
    let confirmAnswers: Answer[] = [];
    const held = await controller.runCommand({ returnWhenHeld: true }, async () => {
      confirmAnswers = open("confirm", "Save?");
      return never<string>();
    });
    expect(held.kind).toBe("held");

    let alertAnswers: Answer[] = [];
    const answered = await controller.runCommand({ returnWhenHeld: false }, async () => {
      controller.answer({ accept: true, by: "agent" });
      alertAnswers = open("alert", "저장되었습니다");
      return "answered";
    });
    expect(confirmAnswers).toEqual([{ accept: true, text: "" }]);
    expect(alertAnswers).toEqual([{ accept: true, text: "" }]);
    expect(answered).toMatchObject({
      kind: "done",
      dialogs: [{ type: "alert", message: "저장되었습니다", action: "accepted" }],
    });
  });

  test("a second frame's dialog while one is held is answered by policy", () => {
    const { controller, open } = setup({ agentDriven: true });
    open("confirm", "main frame", { url: "https://a.example/" });
    expect(open("confirm", "other frame", { url: "https://b.example/frame" })).toEqual([
      { accept: false, text: "" },
    ]);
    expect(controller.current()).toMatchObject({
      message: "main frame",
      url: "https://a.example/",
    });
  });

  test("beforeunload is reported only when an agent is involved", async () => {
    const { controller } = setup();
    controller.handleBeforeUnload();
    expect(controller.takePending()).toEqual([]);
    const outcome = await controller.runCommand({ returnWhenHeld: true }, async () => {
      controller.handleBeforeUnload();
      return "navigated";
    });
    expect(outcome).toMatchObject({
      dialogs: [{ type: "beforeunload", action: "accepted", message: "" }],
    });
  });

  test("a command that starts while a confirm is held returns held at once", async () => {
    const { controller, open } = setup({ agentDriven: true });
    open("confirm", "x");
    let ran = false;
    const outcome = await controller.runCommand({ returnWhenHeld: true }, async () => {
      ran = true;
      return never<string>();
    });
    expect(outcome).toMatchObject({ kind: "held", dialog: { type: "confirm" } });
    expect(ran).toBe(true);
  });

  test("the pending queue keeps the newest 20", () => {
    const { controller, open } = setup();
    for (let index = 0; index < 25; index += 1) open("alert", `a${index}`);
    const pending = controller.takePending();
    expect(pending).toHaveLength(20);
    expect(pending[0]?.message).toBe("a5");
  });

  test("an opening listener hears every dialog before it is answered (delta 100)", async () => {
    const { controller, open } = setup();
    const heard: string[] = [];
    const stop = controller.onOpening((type) => heard.push(type));
    await controller.runCommand({ returnWhenHeld: true }, async () => {
      open("alert", "Saved");
      return "clicked";
    });
    stop();
    open("alert", "Again");
    expect(heard).toEqual(["alert"]);
  });

  test("a person's navigation dismisses the held dialog and tells only an agent that waited (delta 127)", () => {
    const person = setup({ surface: true });
    const personAnswers = person.open("confirm", "Stay?");
    person.controller.dismissForNavigation("person");
    expect(personAnswers).toEqual([{ accept: false, text: "" }]);
    expect(person.controller.current()).toBeNull();
    expect(person.hidden).toHaveLength(1);
    expect(person.controller.takePending()).toEqual([]);

    const agent = setup({ agentDriven: true });
    agent.open("confirm", "Stay?");
    agent.controller.dismissForNavigation("person");
    expect(agent.controller.takePending()).toMatchObject([
      { type: "confirm", action: "dismissed", reason: "page_left" },
    ]);
  });
});

describe("page dialog trail (delta 127)", () => {
  function traced(input: { agentDriven?: boolean; surface?: boolean } = {}) {
    let now = 1_000;
    const traces: PageDialogTrace[] = [];
    const controller = new PageDialogController({
      wasAgentDriven: () => input.agentDriven ?? false,
      surface: { available: () => input.surface ?? false, show: () => {}, hide: () => {} },
      onTrace: (trace) => traces.push(trace),
      now: () => now,
      setTimer: () => null,
      clearTimer: () => {},
    });
    const open = (type: string) => controller.handleOpening({ type, message: "m" }, () => {});
    return {
      controller,
      traces,
      open,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("a held dialog leaves an opened line and an answered line with who and how long", () => {
    const { controller, traces, open, advance } = traced({ surface: true });
    open("confirm");
    advance(2_500);
    controller.answer({ accept: true, by: "person", dialogId: controller.current()?.id ?? "" });
    expect(traces).toEqual([
      { kind: "opened", type: "confirm", message: "m", holder: "person", shown: true },
      { kind: "answered", type: "confirm", by: "person", accept: true, heldMs: 2_500 },
    ]);
  });

  test("dialogs answered as they open are traced as policy or agent", async () => {
    const { controller, traces, open } = traced();
    open("alert");
    await controller.runCommand(
      { returnWhenHeld: false, preArm: { action: "dismiss" } },
      async () => {
        open("confirm");
        return "clicked";
      },
    );
    expect(traces.filter((trace) => trace.kind === "answered")).toEqual([
      { kind: "answered", type: "alert", by: "policy", accept: true, heldMs: 0 },
      { kind: "answered", type: "confirm", by: "agent", accept: false, heldMs: 0 },
    ]);
    expect(traces[0]).toMatchObject({ kind: "opened", holder: "none", shown: false });
  });

  test("page_left covers cancel, navigation, and a destroyed tab", () => {
    const { controller, traces, open } = traced({ surface: true });
    open("confirm");
    controller.handleCancel();
    open("confirm");
    controller.dismissForNavigation("person");
    open("prompt");
    controller.destroy();
    expect(traces.filter((trace) => trace.kind === "answered").map((trace) => trace.by)).toEqual([
      "page_left",
      "page_left",
      "page_left",
    ]);
  });
});
