import { describe, expect, test } from "vitest";
import {
  captureFullPage,
  type FullPageCaptureImage,
  type FullPageCaptureTarget,
} from "./full-page-capture.js";

function solidBitmap(width: number, height: number, value: number): Uint8Array {
  const bitmap = new Uint8Array(width * height * 4);
  bitmap.fill(value);
  return bitmap;
}

class FakeImage implements FullPageCaptureImage {
  public constructor(
    private readonly bitmap: Uint8Array,
    private readonly size: { width: number; height: number },
  ) {}

  public getSize(): { width: number; height: number } {
    return this.size;
  }

  public toBitmap(): Uint8Array {
    return this.bitmap;
  }

  public toPNG(): Uint8Array {
    return this.bitmap;
  }
}

class FullPageCaptureHarness implements FullPageCaptureTarget {
  public readonly scripts: string[] = [];
  public readonly debugCommands: string[] = [];
  public invalidations = 0;
  public outputBitmap: Uint8Array | null = null;
  public outputSize: { width: number; height: number } | null = null;
  private captureIndex = 0;

  public constructor(
    private readonly contentSize: { width: number; height: number },
    private readonly tiles: FullPageCaptureImage[],
    private readonly scrollPosition: (x: number, y: number) => { x: number; y: number } = (
      x,
      y,
    ) => ({ x, y }),
  ) {}

  public async executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code);
    if (code.includes("viewportWidth: innerWidth")) {
      return {
        scrollX: 1,
        scrollY: 1,
        scrollBehavior: "smooth",
        viewportWidth: 2,
        viewportHeight: 2,
      };
    }
    const scrollMatch = code.match(/scrollTo\((\d+), (\d+)\)/);
    if (scrollMatch && code.includes("({ x: scrollX, y: scrollY })")) {
      return this.scrollPosition(Number(scrollMatch[1]), Number(scrollMatch[2]));
    }
    return undefined;
  }

  public invalidate(): void {
    this.invalidations += 1;
  }

  public async sendDebugCommand(command: string): Promise<unknown> {
    this.debugCommands.push(command);
    if (command === "Page.getLayoutMetrics") {
      return { cssContentSize: this.contentSize };
    }
    if (command === "Page.captureScreenshot") {
      return { data: `tile-${this.captureIndex++}` };
    }
    throw new Error(`Unexpected command: ${command}`);
  }

  public createImageFromPng(dataBase64: string): FullPageCaptureImage {
    const index = Number(dataBase64.replace("tile-", ""));
    const tile = this.tiles[index];
    if (!tile) {
      throw new Error(`Missing tile ${index}`);
    }
    return tile;
  }

  public createImageFromBitmap(
    bitmap: Uint8Array,
    size: { width: number; height: number },
  ): FullPageCaptureImage {
    this.outputBitmap = bitmap;
    this.outputSize = size;
    return new FakeImage(bitmap, size);
  }
}

describe("captureFullPage", () => {
  test("stitches successive viewport rows and restores the page scroll state", async () => {
    const top = new FakeImage(solidBitmap(2, 2, 1), { width: 2, height: 2 });
    const bottom = new FakeImage(solidBitmap(2, 2, 2), { width: 2, height: 2 });
    const harness = new FullPageCaptureHarness({ width: 2, height: 4 }, [top, bottom]);

    const image = await captureFullPage(harness);

    expect(image.getSize()).toEqual({ width: 2, height: 4 });
    expect(Array.from(image.toBitmap())).toEqual([...Array(16).fill(1), ...Array(16).fill(2)]);
    expect(harness.debugCommands).toEqual([
      "Page.getLayoutMetrics",
      "Page.captureScreenshot",
      "Page.captureScreenshot",
    ]);
    expect(harness.invalidations).toBe(2);
    const restoreScript = harness.scripts.at(-2) ?? "";
    expect(restoreScript).toContain('document.documentElement.style.scrollBehavior = "smooth"');
    expect(restoreScript.indexOf("scrollTo(1, 1)")).toBeLessThan(
      restoreScript.indexOf('style.scrollBehavior = "smooth"'),
    );
  });

  test("crops the final tile when the browser clamps its scroll position", async () => {
    const first = new FakeImage(solidBitmap(2, 2, 1), { width: 2, height: 2 });
    const second = new FakeImage(solidBitmap(2, 2, 2), { width: 2, height: 2 });
    const finalBitmap = new Uint8Array([...Array(8).fill(3), ...Array(8).fill(4)]);
    const final = new FakeImage(finalBitmap, { width: 2, height: 2 });
    const harness = new FullPageCaptureHarness(
      { width: 2, height: 5 },
      [first, second, final],
      (x, y) => ({ x, y: Math.min(y, 3) }),
    );

    const image = await captureFullPage(harness);

    expect(image.getSize()).toEqual({ width: 2, height: 5 });
    expect(Array.from(image.toBitmap().slice(-8))).toEqual(Array(8).fill(4));
  });

  test("restores the page after a tile capture fails", async () => {
    const harness = new FullPageCaptureHarness({ width: 2, height: 2 }, []);

    await expect(captureFullPage(harness)).rejects.toThrow("Missing tile 0");

    const restoreScript = harness.scripts.at(-2) ?? "";
    expect(restoreScript).toContain("scrollTo(1, 1)");
    expect(restoreScript).toContain('document.documentElement.style.scrollBehavior = "smooth"');
  });
});
