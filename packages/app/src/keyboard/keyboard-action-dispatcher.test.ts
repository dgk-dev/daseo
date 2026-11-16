import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createKeyboardActionDispatcher,
  type KeyboardActionDefinition,
} from "./keyboard-action-dispatcher";

describe("keyboard-action-dispatcher", () => {
  let dispatcher: ReturnType<typeof createKeyboardActionDispatcher>;

  beforeEach(() => {
    dispatcher = createKeyboardActionDispatcher();
  });

  it("dispatches to the highest-priority active handler", () => {
    const calls: string[] = [];
    const action: KeyboardActionDefinition = {
      id: "message-input.dictation-toggle",
      scope: "message-input",
    };

    dispatcher.registerHandler({
      handlerId: "low",
      actions: [action.id],
      enabled: true,
      priority: 100,
      isActive: () => true,
      handle: () => {
        calls.push("low");
        return true;
      },
    });

    dispatcher.registerHandler({
      handlerId: "high",
      actions: [action.id],
      enabled: true,
      priority: 200,
      isActive: () => true,
      handle: () => {
        calls.push("high");
        return true;
      },
    });

    const handled = dispatcher.dispatch(action);

    expect(handled).toBe(true);
    expect(calls).toEqual(["high"]);
  });

  it("delivers the attach-menu action only to a handler that registered it", () => {
    const dictationOnly = vi.fn(() => true);
    const composer = vi.fn(() => true);
    const action: KeyboardActionDefinition = {
      id: "message-input.attach-menu-open",
      scope: "message-input",
    };

    dispatcher.registerHandler({
      handlerId: "dictation-only",
      actions: ["message-input.dictation-toggle"],
      enabled: true,
      priority: 300,
      isActive: () => true,
      handle: dictationOnly,
    });
    dispatcher.registerHandler({
      handlerId: "composer",
      actions: ["message-input.dictation-toggle", action.id],
      enabled: true,
      priority: 100,
      isActive: () => true,
      handle: composer,
    });

    expect(dispatcher.dispatch(action)).toBe(true);
    expect(composer).toHaveBeenCalledWith(action);
    expect(dictationOnly).not.toHaveBeenCalled();
  });

  it("skips disabled and inactive handlers", () => {
    const handle = vi.fn(() => true);
    const action: KeyboardActionDefinition = {
      id: "message-input.dictation-toggle",
      scope: "message-input",
    };

    dispatcher.registerHandler({
      handlerId: "disabled",
      actions: [action.id],
      enabled: false,
      priority: 300,
      isActive: () => true,
      handle,
    });

    dispatcher.registerHandler({
      handlerId: "inactive",
      actions: [action.id],
      enabled: true,
      priority: 200,
      isActive: () => false,
      handle,
    });

    dispatcher.registerHandler({
      handlerId: "active",
      actions: [action.id],
      enabled: true,
      priority: 100,
      isActive: () => true,
      handle,
    });

    const handled = dispatcher.dispatch(action);

    expect(handled).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("dispatches to the active mounted tab when a newer hidden tab is inactive", () => {
    const calls: string[] = [];
    const action: KeyboardActionDefinition = {
      id: "message-input.dictation-toggle",
      scope: "message-input",
    };

    dispatcher.registerHandler({
      handlerId: "visible-tab",
      actions: [action.id],
      enabled: true,
      priority: 100,
      isActive: () => true,
      handle: () => {
        calls.push("visible-tab");
        return true;
      },
    });

    dispatcher.registerHandler({
      handlerId: "hidden-tab",
      actions: [action.id],
      enabled: true,
      priority: 100,
      isActive: () => false,
      handle: () => {
        calls.push("hidden-tab");
        return true;
      },
    });

    const handled = dispatcher.dispatch(action);

    expect(handled).toBe(true);
    expect(calls).toEqual(["visible-tab"]);
  });

  it("tries lower-priority handlers when a higher one does not consume the action", () => {
    const calls: string[] = [];
    const action: KeyboardActionDefinition = {
      id: "message-input.focus",
      scope: "message-input",
    };

    dispatcher.registerHandler({
      handlerId: "first",
      actions: [action.id],
      enabled: true,
      priority: 200,
      isActive: () => true,
      handle: () => {
        calls.push("first");
        return false;
      },
    });

    dispatcher.registerHandler({
      handlerId: "second",
      actions: [action.id],
      enabled: true,
      priority: 100,
      isActive: () => true,
      handle: () => {
        calls.push("second");
        return true;
      },
    });

    const handled = dispatcher.dispatch(action);

    expect(handled).toBe(true);
    expect(calls).toEqual(["first", "second"]);
  });

  it("does not dispatch after a handler is unregistered", () => {
    const handle = vi.fn(() => true);
    const action: KeyboardActionDefinition = {
      id: "message-input.dictation-cancel",
      scope: "message-input",
    };

    const unregister = dispatcher.registerHandler({
      handlerId: "handler",
      actions: [action.id],
      enabled: true,
      priority: 100,
      isActive: () => true,
      handle,
    });

    unregister();

    const handled = dispatcher.dispatch(action);

    expect(handled).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });
});
