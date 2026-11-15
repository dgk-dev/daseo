// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  readBytes: vi.fn(),
}));

vi.mock("@/constants/platform", () => ({ isNative: true, isWeb: false }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => null, isElectronRuntime: () => false }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    bytes() {
      return mocks.readBytes();
    }
  },
}));
vi.mock("expo-image-picker", () => ({
  PermissionStatus: { UNDETERMINED: "undetermined" },
  useMediaLibraryPermissions: () => [{ status: "granted", granted: true }, vi.fn()],
  getPendingResultAsync: async () => null,
  launchImageLibraryAsync: mocks.launch,
}));
vi.mock("@/hooks/image-attachment-picker", () => ({
  normalizePickedImageAssets: async (assets: Array<{ uri: string }>) =>
    assets.map((asset) => ({
      source: { kind: "file_uri", uri: asset.uri },
      mimeType: "image/jpeg",
    })),
  pickImagesWithDesktopDialog: async () => [],
}));

import { useImageAttachmentPicker } from "./use-image-attachment-picker";

describe("useImageAttachmentPicker isProcessingSelection", () => {
  beforeEach(() => {
    mocks.launch.mockReset();
    mocks.readBytes.mockReset();
  });

  it("stays true while an oversized photo of the selection is still being read", async () => {
    let finishRead: (bytes: Uint8Array) => void = () => undefined;
    mocks.readBytes.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        finishRead = resolve;
      }),
    );
    mocks.launch.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: "file:///big.jpg", fileName: "big.jpg", width: 16_384, height: 12_288 },
        { uri: "file:///small.jpg", fileName: "small.jpg", width: 100, height: 100 },
      ],
    });
    const onOversizedFiles = vi.fn();
    const { result } = renderHook(() => useImageAttachmentPicker({ onOversizedFiles }));
    expect(result.current.isProcessingSelection).toBe(false);

    let picked: Promise<unknown> = Promise.resolve();
    act(() => {
      picked = result.current.pickImages();
    });
    expect(result.current.isProcessingSelection).toBe(true);
    await vi.waitFor(() => expect(mocks.readBytes).toHaveBeenCalled());
    expect(result.current.isProcessingSelection).toBe(true);

    await act(async () => {
      finishRead(new Uint8Array([1]));
      await picked;
    });
    expect(onOversizedFiles).toHaveBeenCalledTimes(1);
    expect(result.current.isProcessingSelection).toBe(false);
  });

  it("covers work wrapped in withSelectionPending, such as persisting the picked images", async () => {
    const { result } = renderHook(() => useImageAttachmentPicker());
    let release: () => void = () => undefined;
    const persisting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persist = () => persisting;
    let pending: Promise<void> = Promise.resolve();

    act(() => {
      pending = result.current.withSelectionPending(persist);
    });
    expect(result.current.isProcessingSelection).toBe(true);

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.isProcessingSelection).toBe(false);
  });
});
