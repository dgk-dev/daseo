import { useCallback, useEffect, useRef } from "react";
import { Alert, AppState } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import { useTranslation } from "react-i18next";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  normalizePickedImageAssets,
  pickImagesWithDesktopDialog,
  type PickedImageAttachmentInput,
} from "@/hooks/image-attachment-picker";
import { exceedsImageSourceBudget } from "@/attachments/image-budget";
import { getMimeTypeFromPath } from "@/attachments/file-types";
import type { PickedFile } from "@/attachments/picked-file";
import { isNative, isWeb } from "@/constants/platform";

interface UseImageAttachmentPickerOptions {
  /**
   * Daseo (delta 45): photos over the image budget (e.g. 200MP shots) are handed here as
   * files instead of failing the whole pick; the composer uploads them like "Upload file".
   */
  onOversizedFiles?: (files: PickedFile[]) => void;
}

interface UseImageAttachmentPickerResult {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
}

const MAX_OVERSIZED_FILE_BYTES = 50 * 1024 * 1024;
// A pick still "launching" after the app has been back in the foreground this long lost its
// native result (Activity destroyed while the picker was open); release the guard.
const STALE_LAUNCH_GRACE_MS = 1500;

type PickPhase = "idle" | "launching" | "processing";

function describeError(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return null;
}

async function readOversizedAssets(
  assets: readonly ImagePicker.ImagePickerAsset[],
): Promise<PickedFile[]> {
  const files: PickedFile[] = [];
  for (const asset of assets) {
    const fileName = asset.fileName ?? asset.uri.split("/").pop() ?? "photo";
    if (asset.fileSize != null && asset.fileSize > MAX_OVERSIZED_FILE_BYTES) {
      throw new Error(`${fileName} is larger than 50MB.`);
    }
    files.push({
      fileName,
      mimeType: asset.mimeType ?? getMimeTypeFromPath(fileName),
      bytes: await new File(asset.uri).bytes(),
    });
  }
  return files;
}

export function useImageAttachmentPicker(
  options: UseImageAttachmentPickerOptions = {},
): UseImageAttachmentPickerResult {
  const { t } = useTranslation();
  const [mediaPermission, requestMediaPermission] = ImagePicker.useMediaLibraryPermissions();
  const phaseRef = useRef<PickPhase>("idle");
  const activeSinceRef = useRef<number>(Date.now());
  const onOversizedFilesRef = useRef(options.onOversizedFiles);
  onOversizedFilesRef.current = options.onOversizedFiles;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") activeSinceRef.current = Date.now();
    });
    return () => subscription.remove();
  }, []);

  const ensurePermission = useCallback(async () => {
    let currentPermission = mediaPermission;

    if (
      !currentPermission ||
      currentPermission.status === ImagePicker.PermissionStatus.UNDETERMINED
    ) {
      currentPermission = await requestMediaPermission();
    } else if (!currentPermission.granted) {
      currentPermission = await requestMediaPermission();
    }

    if (!currentPermission?.granted) {
      Alert.alert(
        t("imageAttachmentPicker.permissionTitle"),
        t("imageAttachmentPicker.permissionMessage"),
      );
      return false;
    }

    return true;
  }, [mediaPermission, requestMediaPermission, t]);

  const normalizeAssets = useCallback(
    async (
      assets: readonly ImagePicker.ImagePickerAsset[],
    ): Promise<PickedImageAttachmentInput[] | null> => {
      phaseRef.current = "processing";
      const oversized = isNative
        ? assets.filter((asset) =>
            exceedsImageSourceBudget({
              byteSize: asset.fileSize,
              width: asset.width,
              height: asset.height,
            }),
          )
        : [];
      const withinBudget = assets.filter((asset) => !oversized.includes(asset));
      if (oversized.length > 0) {
        const files = await readOversizedAssets(oversized);
        onOversizedFilesRef.current?.(files);
      }
      if (withinBudget.length === 0) return null;
      return await normalizePickedImageAssets(withinBudget);
    },
    [],
  );

  const pickImages = useCallback(async () => {
    if (phaseRef.current !== "idle") {
      const stale =
        phaseRef.current === "launching" &&
        AppState.currentState === "active" &&
        Date.now() - activeSinceRef.current > STALE_LAUNCH_GRACE_MS;
      if (!stale) return null;
      // The previous launch will never settle; its selection, if any, is the pending result.
      phaseRef.current = "idle";
    }

    phaseRef.current = "launching";

    try {
      if (isWeb && isElectronRuntime()) {
        const selectedImages = await pickImagesWithDesktopDialog(getDesktopHost()?.dialog);
        if (selectedImages.length === 0) {
          return null;
        }
        return selectedImages;
      }

      const hasPermission = await ensurePermission();
      if (!hasPermission) {
        return null;
      }

      const pendingResult = await ImagePicker.getPendingResultAsync();
      if (pendingResult && "canceled" in pendingResult && !pendingResult.canceled) {
        return await normalizeAssets(pendingResult.assets);
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"] as ImagePicker.MediaType[],
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (result.canceled) {
        return null;
      }

      return await normalizeAssets(result.assets);
    } catch (error) {
      console.error("[ImageAttachmentPicker] Failed to pick image:", error);
      const reason = describeError(error);
      Alert.alert(
        t("imageAttachmentPicker.errorTitle"),
        reason
          ? `${t("imageAttachmentPicker.failedToSelect")}\n\n${reason}`
          : t("imageAttachmentPicker.failedToSelect"),
      );
      return null;
    } finally {
      phaseRef.current = "idle";
    }
  }, [ensurePermission, normalizeAssets, t]);

  return { pickImages };
}
