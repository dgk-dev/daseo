import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATUS_RING_HEAD_OPACITY,
  STATUS_RING_PERIOD_MS,
  STATUS_RING_SIZE,
  STATUS_RING_STROKE,
} from "@/components/status-ring/geometry";

// Daseo delta 88: the Android ring's turning quarter is a native drawable. Its numbers are written
// into XML and Kotlin, so this pins them to the geometry the iOS and web rings use.
const MODULE_ROOT = resolve(__dirname, "../../../modules/daseo-status-ring/android/src/main");
const drawableXml = readFileSync(
  resolve(MODULE_ROOT, "res/drawable/daseo_status_ring_arc.xml"),
  "utf8",
);
const viewKotlin = readFileSync(
  resolve(MODULE_ROOT, "java/sh/paseo/dgkstatusring/DaseoStatusRingView.kt"),
  "utf8",
);

function attribute(name: string): string {
  const match = drawableXml.match(new RegExp(`android:${name}="([^"]+)"`));
  if (!match) throw new Error(`missing android:${name}`);
  return match[1];
}

function format(value: number): string {
  return value.toFixed(4);
}

// What React Native's BorderDrawable draws for a lone top border on a fully rounded box: the band
// between the outer and inner circles, cut along the diagonals through the centre (225°..315°).
function expectedArcPath(): string {
  const centre = STATUS_RING_SIZE / 2;
  const outer = STATUS_RING_SIZE / 2;
  const inner = outer - STATUS_RING_STROKE;
  const point = (radius: number, degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return [centre + radius * Math.cos(radians), centre + radius * Math.sin(radians)].map(format);
  };
  const [o1x, o1y] = point(outer, 225);
  const [o2x, o2y] = point(outer, 315);
  const [i2x, i2y] = point(inner, 315);
  const [i1x, i1y] = point(inner, 225);
  return (
    `M${o1x},${o1y} A${outer},${outer} 0 0,1 ${o2x},${o2y} ` +
    `L${i2x},${i2y} A${inner},${inner} 0 0,0 ${i1x},${i1y} Z`
  );
}

describe("Android status ring drawable", () => {
  it("has the ring's size, viewport and pivot", () => {
    expect(attribute("width")).toBe(`${STATUS_RING_SIZE}dp`);
    expect(attribute("viewportWidth")).toBe(String(STATUS_RING_SIZE));
    expect(attribute("pivotX")).toBe(String(STATUS_RING_SIZE / 2));
    expect(attribute("pivotY")).toBe(String(STATUS_RING_SIZE / 2));
  });

  it("draws the same quarter band as the React Native border", () => {
    expect(attribute("pathData")).toBe(expectedArcPath());
    expect(Number(attribute("fillAlpha"))).toBe(STATUS_RING_HEAD_OPACITY);
  });

  it("turns once per ring period, linearly and forever", () => {
    expect(Number(attribute("duration"))).toBe(STATUS_RING_PERIOD_MS);
    expect(attribute("interpolator")).toBe("@android:anim/linear_interpolator");
    expect(attribute("repeatCount")).toBe("infinite");
    expect(viewKotlin).toContain(`const val RING_PERIOD_MS = ${STATUS_RING_PERIOD_MS}L`);
  });
});
