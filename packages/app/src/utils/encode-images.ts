import type { AttachmentMetadata } from "@/attachments/types";
import { encodeAttachmentsForSend } from "@/attachments/service";
import { uploadEncodedImages, type ComposerSendClient } from "@/composer/actions";

type ImageInput = AttachmentMetadata;

export async function encodeImages(
  images?: ImageInput[],
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  return await encodeAttachmentsForSend(images);
}

type ImageUploadClient = Pick<ComposerSendClient, "uploadFile" | "getLastServerInfoMessage">;

/**
 * Delta 46: encodes images for a create/send request. A host that advertises
 * `features.imageUploads` receives them through the chunked upload; older hosts get them
 * inline as before.
 */
export async function encodeImagesForHost(input: {
  client: ImageUploadClient;
  images?: ImageInput[];
}): Promise<{
  images?: Array<{ data: string; mimeType: string }>;
  imageUploads?: Array<{ uploadId: string; mimeType: string }>;
}> {
  const encoded = await encodeImages(input.images);
  if (!encoded || encoded.length === 0) return {};
  if (input.client.getLastServerInfoMessage?.()?.features?.imageUploads !== true) {
    return { images: encoded };
  }
  return { imageUploads: await uploadEncodedImages({ client: input.client, images: encoded }) };
}
