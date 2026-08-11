import { randomUUID } from "node:crypto";

export interface FullPageCaptureImage {
  getSize(): { width: number; height: number };
  toBitmap(): Uint8Array;
  toPNG(): Uint8Array;
}

export interface FullPageCaptureTarget {
  executeJavaScript(code: string): Promise<unknown>;
  invalidate(): void;
  sendDebugCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  createImageFromPng(dataBase64: string): FullPageCaptureImage;
  createImageFromBitmap(
    bitmap: Uint8Array,
    size: { width: number; height: number },
  ): FullPageCaptureImage;
}

interface PageCaptureState {
  scrollX: number;
  scrollY: number;
  scrollBehavior: string;
  viewportWidth: number;
  viewportHeight: number;
}

interface PageContentSize {
  width: number;
  height: number;
}

interface PixelScale {
  x: number;
  y: number;
}

export class FullPageCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FullPageCaptureError";
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new FullPageCaptureError(`${label} returned invalid data`);
  }
  return value as Record<string, unknown>;
}

function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FullPageCaptureError(`${label} returned an invalid number`);
  }
  return value;
}

function readPositiveDimension(value: unknown, label: string): number {
  const dimension = Math.ceil(readFiniteNumber(value, label));
  if (dimension <= 0) {
    throw new FullPageCaptureError(`${label} returned a non-positive dimension`);
  }
  return dimension;
}

function readPageCaptureState(value: unknown): PageCaptureState {
  const state = readRecord(value, "Browser page state");
  return {
    scrollX: readFiniteNumber(state.scrollX, "Browser scrollX"),
    scrollY: readFiniteNumber(state.scrollY, "Browser scrollY"),
    scrollBehavior: typeof state.scrollBehavior === "string" ? state.scrollBehavior : "",
    viewportWidth: readPositiveDimension(state.viewportWidth, "Browser viewport width"),
    viewportHeight: readPositiveDimension(state.viewportHeight, "Browser viewport height"),
  };
}

function readScrollPosition(value: unknown): { x: number; y: number } {
  const position = readRecord(value, "Browser scroll position");
  return {
    x: readFiniteNumber(position.x, "Browser scroll x"),
    y: readFiniteNumber(position.y, "Browser scroll y"),
  };
}

function readContentSize(value: unknown): PageContentSize {
  const metrics = readRecord(value, "Page.getLayoutMetrics");
  const content = readRecord(metrics.cssContentSize ?? metrics.contentSize, "Page content size");
  return {
    width: readPositiveDimension(content.width, "Page content width"),
    height: readPositiveDimension(content.height, "Page content height"),
  };
}

function readScreenshotData(value: unknown): string {
  const screenshot = readRecord(value, "Page.captureScreenshot");
  if (typeof screenshot.data !== "string" || screenshot.data.length === 0) {
    throw new FullPageCaptureError("Page.captureScreenshot returned no data");
  }
  return screenshot.data;
}

function tileOrigins(total: number, viewport: number): number[] {
  const origins: number[] = [];
  for (let origin = 0; origin < total; origin += viewport) {
    origins.push(origin);
  }
  return origins;
}

function copyTile(input: {
  output: Uint8Array;
  outputWidth: number;
  content: PageContentSize;
  viewport: { width: number; height: number };
  target: { x: number; y: number };
  actualScroll: { x: number; y: number };
  tile: FullPageCaptureImage;
  scale: PixelScale;
}): void {
  const tileSize = input.tile.getSize();
  const targetLeft = Math.round(input.target.x * input.scale.x);
  const targetTop = Math.round(input.target.y * input.scale.y);
  const targetRight = Math.round(
    Math.min(input.target.x + input.viewport.width, input.content.width) * input.scale.x,
  );
  const targetBottom = Math.round(
    Math.min(input.target.y + input.viewport.height, input.content.height) * input.scale.y,
  );
  const copyWidth = targetRight - targetLeft;
  const copyHeight = targetBottom - targetTop;
  const sourceLeft = Math.round((input.target.x - input.actualScroll.x) * input.scale.x);
  const sourceTop = Math.round((input.target.y - input.actualScroll.y) * input.scale.y);
  if (
    sourceLeft < 0 ||
    sourceTop < 0 ||
    sourceLeft + copyWidth > tileSize.width ||
    sourceTop + copyHeight > tileSize.height
  ) {
    throw new FullPageCaptureError("Full-page tile does not cover its target region");
  }

  const bitmap = input.tile.toBitmap();
  if (bitmap.length < tileSize.width * tileSize.height * 4) {
    throw new FullPageCaptureError("Full-page tile returned an incomplete bitmap");
  }
  for (let row = 0; row < copyHeight; row += 1) {
    const sourceOffset = ((sourceTop + row) * tileSize.width + sourceLeft) * 4;
    const targetOffset = ((targetTop + row) * input.outputWidth + targetLeft) * 4;
    input.output.set(bitmap.subarray(sourceOffset, sourceOffset + copyWidth * 4), targetOffset);
  }
}

async function waitForGuestPaint(target: FullPageCaptureTarget): Promise<void> {
  await target.executeJavaScript(`new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 100);
  })`);
}

async function captureTiles(
  target: FullPageCaptureTarget,
  viewport: { width: number; height: number },
): Promise<{ bitmap: Uint8Array; size: { width: number; height: number } }> {
  const content = readContentSize(await target.sendDebugCommand("Page.getLayoutMetrics"));
  const targetXs = tileOrigins(content.width, viewport.width);
  const targetYs = tileOrigins(content.height, viewport.height);
  let output: Uint8Array | null = null;
  let outputSize = { width: 0, height: 0 };
  let scale: PixelScale | null = null;

  for (const y of targetYs) {
    for (const x of targetXs) {
      const actualScroll = readScrollPosition(
        await target.executeJavaScript(`scrollTo(${x}, ${y}); ({ x: scrollX, y: scrollY })`),
      );
      await waitForGuestPaint(target);
      target.invalidate();
      const dataBase64 = readScreenshotData(
        await target.sendDebugCommand("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        }),
      );
      const tile = target.createImageFromPng(dataBase64);
      const tileSize = tile.getSize();
      if (!scale) {
        scale = {
          x: tileSize.width / viewport.width,
          y: tileSize.height / viewport.height,
        };
        if (
          !Number.isFinite(scale.x) ||
          !Number.isFinite(scale.y) ||
          scale.x <= 0 ||
          scale.y <= 0 ||
          Math.abs(scale.x - scale.y) > 0.01
        ) {
          throw new FullPageCaptureError("Full-page tile returned an invalid pixel scale");
        }
        outputSize = {
          width: Math.round(content.width * scale.x),
          height: Math.round(content.height * scale.y),
        };
        output = new Uint8Array(outputSize.width * outputSize.height * 4);
      }
      if (!output || !scale) {
        throw new FullPageCaptureError("Full-page capture did not initialize its bitmap");
      }
      if (
        tileSize.width !== Math.round(viewport.width * scale.x) ||
        tileSize.height !== Math.round(viewport.height * scale.y)
      ) {
        throw new FullPageCaptureError("Full-page tile dimensions changed during capture");
      }
      copyTile({
        output,
        outputWidth: outputSize.width,
        content,
        viewport,
        target: { x, y },
        actualScroll,
        tile,
        scale,
      });
    }
  }

  if (!output) {
    throw new FullPageCaptureError("Full-page capture produced no tiles");
  }
  return { bitmap: output, size: outputSize };
}

export async function captureFullPage(
  target: FullPageCaptureTarget,
): Promise<FullPageCaptureImage> {
  const captureToken = `__paseoFullPageCapture_${randomUUID().replaceAll("-", "")}`;
  const originalState = readPageCaptureState(
    await target.executeJavaScript(`({
      scrollX,
      scrollY,
      scrollBehavior: document.documentElement.style.scrollBehavior,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight
    })`),
  );

  try {
    await target.executeJavaScript(`(() => {
      const style = document.createElement('style');
      style.textContent = '::-webkit-scrollbar { display: none !important; }';
      document.documentElement.appendChild(style);
      globalThis[${JSON.stringify(captureToken)}] = style;
      document.documentElement.style.scrollBehavior = 'auto';
    })()`);
    await waitForGuestPaint(target);

    const capture = await captureTiles(target, {
      width: originalState.viewportWidth,
      height: originalState.viewportHeight,
    });
    return target.createImageFromBitmap(capture.bitmap, capture.size);
  } finally {
    await target.executeJavaScript(`
      globalThis[${JSON.stringify(captureToken)}]?.remove();
      delete globalThis[${JSON.stringify(captureToken)}];
      scrollTo(${originalState.scrollX}, ${originalState.scrollY});
      document.documentElement.style.scrollBehavior = ${JSON.stringify(originalState.scrollBehavior)};
    `);
    await waitForGuestPaint(target);
  }
}
