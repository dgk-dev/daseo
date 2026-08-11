import { randomUUID } from "node:crypto";
import { z, type ZodType } from "zod";

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

const FiniteNumberSchema = z.number().finite();
const PositiveDimensionSchema = FiniteNumberSchema.positive().transform(Math.ceil);
const PageCaptureStateSchema = z.object({
  scrollX: FiniteNumberSchema,
  scrollY: FiniteNumberSchema,
  viewportWidth: PositiveDimensionSchema,
  viewportHeight: PositiveDimensionSchema,
});
const ScrollPositionSchema = z.object({
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
});
const PageContentSizeSchema = z.object({
  width: PositiveDimensionSchema,
  height: PositiveDimensionSchema,
});
const LayoutMetricsSchema = z.object({
  cssContentSize: PageContentSizeSchema.optional(),
  contentSize: PageContentSizeSchema.optional(),
});
const ScreenshotResultSchema = z.object({ data: z.string().min(1) });

type PageCaptureState = z.output<typeof PageCaptureStateSchema>;
type PageContentSize = z.output<typeof PageContentSizeSchema>;

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

function parseBoundary<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new FullPageCaptureError(`${label} returned invalid data`);
  }
  return parsed.data;
}

function readPageCaptureState(value: unknown): PageCaptureState {
  return parseBoundary(PageCaptureStateSchema, value, "Browser page state");
}

function readScrollPosition(value: unknown): { x: number; y: number } {
  return parseBoundary(ScrollPositionSchema, value, "Browser scroll position");
}

function readContentSize(value: unknown): PageContentSize {
  const metrics = parseBoundary(LayoutMetricsSchema, value, "Page.getLayoutMetrics");
  const content = metrics.cssContentSize ?? metrics.contentSize;
  if (!content) {
    throw new FullPageCaptureError("Page.getLayoutMetrics returned no content size");
  }
  return content;
}

function readScreenshotData(value: unknown): string {
  return parseBoundary(ScreenshotResultSchema, value, "Page.captureScreenshot").data;
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

async function scrollGuest(
  target: FullPageCaptureTarget,
  position: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return readScrollPosition(
    await target.executeJavaScript(`(() => {
      const scrollingElement = document.scrollingElement ?? document.documentElement;
      scrollingElement.scrollLeft = ${position.x};
      scrollingElement.scrollTop = ${position.y};
      return { x: scrollingElement.scrollLeft, y: scrollingElement.scrollTop };
    })()`),
  );
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
      const actualScroll = await scrollGuest(target, { x, y });
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
      viewportWidth: innerWidth,
      viewportHeight: innerHeight
    })`),
  );

  try {
    await target.executeJavaScript(`(() => {
      const style = document.createElement('style');
      style.textContent = [
        ':root { overflow: auto !important; overflow-anchor: none !important; scroll-behavior: auto !important; scroll-snap-type: none !important; }',
        'body { overflow: visible !important; overflow-anchor: none !important; scroll-behavior: auto !important; scroll-snap-type: none !important; }',
        '::-webkit-scrollbar { display: none !important; }'
      ].join(' ');
      document.documentElement.appendChild(style);
      globalThis[${JSON.stringify(captureToken)}] = style;
    })()`);
    await waitForGuestPaint(target);

    const capture = await captureTiles(target, {
      width: originalState.viewportWidth,
      height: originalState.viewportHeight,
    });
    return target.createImageFromBitmap(capture.bitmap, capture.size);
  } finally {
    await target.executeJavaScript(`(() => {
      const scrollingElement = document.scrollingElement ?? document.documentElement;
      try {
        scrollingElement.scrollLeft = ${originalState.scrollX};
        scrollingElement.scrollTop = ${originalState.scrollY};
      } finally {
        globalThis[${JSON.stringify(captureToken)}]?.remove();
        delete globalThis[${JSON.stringify(captureToken)}];
      }
    })()`);
    await waitForGuestPaint(target);
  }
}
