// Daseo delta 139: the other devices show a synced draft's image from this thumbnail alone, so it
// stays small (about 256 px on the long side, a few tens of KB as JPEG).
export const THUMBNAIL_MAX_DIMENSION = 256;
export const THUMBNAIL_JPEG_QUALITY = 0.7;

export function fitThumbnailSize(input: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const largest = Math.max(input.width, input.height);
  if (largest <= THUMBNAIL_MAX_DIMENSION) {
    return { width: Math.max(1, input.width), height: Math.max(1, input.height) };
  }
  const scale = THUMBNAIL_MAX_DIMENSION / largest;
  return {
    width: Math.max(1, Math.round(input.width * scale)),
    height: Math.max(1, Math.round(input.height * scale)),
  };
}
