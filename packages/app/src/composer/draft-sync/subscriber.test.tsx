/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostState = vi.hoisted(() => ({
  supported: false,
  client: { id: "client" } as unknown,
  attach: vi.fn(async () => undefined),
  detach: vi.fn(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "srv" }],
  useHostRuntimeClient: () => hostState.client,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "composerDraftSync" && hostState.supported,
}));

vi.mock("@/composer/draft-sync/composer-draft-sync", () => ({
  composerDraftSync: { attach: hostState.attach, detach: hostState.detach },
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));

import { ComposerDraftSyncSubscriber } from "./subscriber";

describe("ComposerDraftSyncSubscriber (delta 139)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    hostState.attach.mockClear();
    hostState.detach.mockClear();
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("leaves a host without composerDraftSync on device-local drafts, as before", () => {
    hostState.supported = false;
    act(() => root.render(<ComposerDraftSyncSubscriber />));
    expect(hostState.attach).not.toHaveBeenCalled();
  });

  it("attaches a connected host with the feature and detaches on unmount", () => {
    hostState.supported = true;
    act(() => root.render(<ComposerDraftSyncSubscriber />));
    expect(hostState.attach).toHaveBeenCalledWith("srv", hostState.client);

    act(() => root.unmount());
    expect(hostState.detach).toHaveBeenCalledWith("srv");
    root = createRoot(container);
  });
});
