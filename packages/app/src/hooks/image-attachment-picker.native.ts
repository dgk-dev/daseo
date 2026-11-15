import type { PickedImageAttachmentInput } from "./picked-image-normalizer";

export { normalizePickedImageAssets } from "./picked-image-normalizer";
export type {
  ExpoImagePickerAssetLike,
  PickedImageAttachmentInput,
  PickedImageSource,
} from "./picked-image-normalizer";

export async function pickImagesWithDesktopDialog(
  _dialog?: unknown,
): Promise<PickedImageAttachmentInput[]> {
  throw new Error("Desktop dialog API is not available on native.");
}
