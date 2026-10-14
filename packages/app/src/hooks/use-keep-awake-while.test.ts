// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useKeepAwakeWhile } from "./use-keep-awake-while";

const mocks = vi.hoisted(() => ({
  isNative: true,
  calls: [] as string[],
  activateKeepAwakeAsync: vi.fn(),
  deactivateKeepAwake: vi.fn(),
}));

vi.mock("@/constants/platform", () => ({
  get isNative() {
    return mocks.isNative;
  },
}));

vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: mocks.activateKeepAwakeAsync,
  deactivateKeepAwake: mocks.deactivateKeepAwake,
}));

describe("useKeepAwakeWhile", () => {
  beforeEach(() => {
    mocks.isNative = true;
    mocks.calls.splice(0);
    mocks.activateKeepAwakeAsync.mockReset().mockImplementation(async (tag: string) => {
      mocks.calls.push(`activate:${tag}`);
    });
    mocks.deactivateKeepAwake.mockReset().mockImplementation(async (tag: string) => {
      mocks.calls.push(`deactivate:${tag}`);
    });
  });

  it("holds the lock only while active, releasing it after the activation", async () => {
    const { rerender } = renderHook(({ active }) => useKeepAwakeWhile(active, "stream"), {
      initialProps: { active: false },
    });
    expect(mocks.activateKeepAwakeAsync).not.toHaveBeenCalled();

    rerender({ active: true });
    await vi.waitFor(() => expect(mocks.calls).toEqual(["activate:stream"]));

    rerender({ active: false });
    await vi.waitFor(() => expect(mocks.calls).toEqual(["activate:stream", "deactivate:stream"]));

    rerender({ active: true });
    await vi.waitFor(() =>
      expect(mocks.calls).toEqual(["activate:stream", "deactivate:stream", "activate:stream"]),
    );
  });

  it("releases the lock on unmount", async () => {
    const { unmount } = renderHook(() => useKeepAwakeWhile(true, "stream"));
    unmount();

    await vi.waitFor(() => expect(mocks.calls).toEqual(["activate:stream", "deactivate:stream"]));
  });

  it("still releases when activation fails, and never throws", async () => {
    mocks.activateKeepAwakeAsync.mockRejectedValueOnce(new Error("no activity"));
    mocks.deactivateKeepAwake.mockRejectedValueOnce(new Error("not held"));
    const { unmount } = renderHook(() => useKeepAwakeWhile(true, "stream"));
    unmount();

    await vi.waitFor(() => expect(mocks.deactivateKeepAwake).toHaveBeenCalledWith("stream"));
  });

  it("never touches keep-awake on web", async () => {
    mocks.isNative = false;
    const { rerender, unmount } = renderHook(({ active }) => useKeepAwakeWhile(active, "stream"), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    unmount();
    await Promise.resolve();

    expect(mocks.activateKeepAwakeAsync).not.toHaveBeenCalled();
    expect(mocks.deactivateKeepAwake).not.toHaveBeenCalled();
  });
});
