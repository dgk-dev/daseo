/**
 * Map a touch point inside the letterboxed "contain" image to CSS pixel
 * coordinates of the streamed desktop guest viewport.
 */
export function mapTouchToGuest(input: {
  touchX: number;
  touchY: number;
  containerWidth: number;
  containerHeight: number;
  frameWidth: number;
  frameHeight: number;
}): { x: number; y: number } | null {
  const { touchX, touchY, containerWidth, containerHeight, frameWidth, frameHeight } = input;
  if (containerWidth <= 0 || containerHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) {
    return null;
  }
  const scale = Math.min(containerWidth / frameWidth, containerHeight / frameHeight);
  const displayedWidth = frameWidth * scale;
  const displayedHeight = frameHeight * scale;
  const offsetX = (containerWidth - displayedWidth) / 2;
  const offsetY = (containerHeight - displayedHeight) / 2;
  const localX = touchX - offsetX;
  const localY = touchY - offsetY;
  if (localX < 0 || localY < 0 || localX > displayedWidth || localY > displayedHeight) {
    return null;
  }
  return {
    x: Math.round((localX / scale) * 10) / 10,
    y: Math.round((localY / scale) * 10) / 10,
  };
}
