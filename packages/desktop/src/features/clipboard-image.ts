interface ClipboardImageLike {
  isEmpty(): boolean;
  toDataURL(): string;
}

interface ClipboardImageReaderLike {
  readImage(): ClipboardImageLike;
}

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export function readClipboardImageDataUrl(clipboard: ClipboardImageReaderLike): string | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }
  const dataUrl = image.toDataURL();
  return dataUrl.startsWith(PNG_DATA_URL_PREFIX) && dataUrl.length > PNG_DATA_URL_PREFIX.length
    ? dataUrl
    : null;
}
