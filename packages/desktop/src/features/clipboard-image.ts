interface ClipboardItemLike {
  readonly types: readonly string[];
  getType(type: string): Promise<unknown>;
}

interface ClipboardImageReaderLike {
  read(): Promise<ClipboardItemLike[]>;
}

const PNG_MIME_TYPE = "image/png";
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

// Electron 44 replaced `clipboard.readImage()` with the W3C-shaped `clipboard.read()`.
// Chromium reports any image macOS can decode (PNG, TIFF screenshots, JPEG) as `image/png`
// and encodes it to PNG on `getType`, so the result stays the canonical PNG data URL.
export async function readClipboardImageDataUrl(
  clipboard: ClipboardImageReaderLike,
): Promise<string | null> {
  const items = await clipboard.read();
  const item = items.find((candidate) => candidate.types.includes(PNG_MIME_TYPE));
  if (!item) {
    return null;
  }
  const payload = await item.getType(PNG_MIME_TYPE);
  if (!(payload instanceof Blob) || payload.size === 0) {
    return null;
  }
  const bytes = Buffer.from(await payload.arrayBuffer());
  return `${PNG_DATA_URL_PREFIX}${bytes.toString("base64")}`;
}
