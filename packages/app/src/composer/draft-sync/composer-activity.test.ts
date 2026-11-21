import { describe, expect, it } from "vitest";
import { ComposerActivity, RECENT_EDIT_MS } from "./composer-activity";

// Daseo delta 139: when a synced draft from another device must wait.
function createActivity() {
  const clock = { now: 10_000, composing: false };
  const endListeners = new Set<() => void>();
  const activity = new ComposerActivity({
    now: () => clock.now,
    isComposing: () => clock.composing,
    subscribeCompositionEnd: (listener) => {
      endListeners.add(listener);
      return () => endListeners.delete(listener);
    },
  });
  const idle: Array<string | null> = [];
  activity.onMaybeIdle((draftKey) => idle.push(draftKey));
  const endComposition = () => {
    clock.composing = false;
    for (const listener of endListeners) listener();
  };
  return { activity, clock, idle, endComposition };
}

describe("ComposerActivity", () => {
  it("is not busy for a composer that is not focused, even right after typing", () => {
    const { activity } = createActivity();
    activity.noteLocalEdit("k");
    expect(activity.isBusy("k")).toBe(false);
  });

  it("is busy while focused and typed within 2 s, and says when that ends", () => {
    const { activity, clock } = createActivity();
    activity.setFocused("k", true);
    expect(activity.isBusy("k")).toBe(false);
    activity.noteLocalEdit("k");
    clock.now += RECENT_EDIT_MS - 500;
    expect(activity.isBusy("k")).toBe(true);
    expect(activity.msUntilEditIdle("k")).toBe(500);
    clock.now += 500;
    expect(activity.isBusy("k")).toBe(false);
  });

  it("is busy while an input method composes in the focused composer", () => {
    const { activity, clock, idle, endComposition } = createActivity();
    activity.setFocused("k", true);
    clock.composing = true;
    expect(activity.isBusy("k")).toBe(true);
    endComposition();
    expect(activity.isBusy("k")).toBe(false);
    expect(idle).toEqual([null]);
  });

  it("is busy while dictating, focused or not, and reports the end", () => {
    const { activity, idle } = createActivity();
    activity.setDictating("k", true);
    expect(activity.isBusy("k")).toBe(true);
    activity.setDictating("k", false);
    expect(activity.isBusy("k")).toBe(false);
    expect(idle).toEqual(["k"]);
  });

  it("reports a blur so a held draft is applied", () => {
    const { activity, idle } = createActivity();
    activity.setFocused("k", true);
    activity.noteLocalEdit("k");
    activity.setFocused("k", false);
    expect(activity.isBusy("k")).toBe(false);
    expect(idle).toEqual(["k"]);
  });
});
