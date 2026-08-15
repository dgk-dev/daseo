import { describe, expect, test } from "vitest";
import { mapTouchToGuest } from "./remote-viewport";

describe("mapTouchToGuest", () => {
  test("maps touches through a letterboxed contain fit", () => {
    // 1000x500 frame shown in a 500x500 container: scale 0.5, vertical offset 125.
    expect(
      mapTouchToGuest({
        touchX: 250,
        touchY: 250,
        containerWidth: 500,
        containerHeight: 500,
        frameWidth: 1000,
        frameHeight: 500,
      }),
    ).toEqual({ x: 500, y: 250 });
  });

  test("rejects touches inside the letterbox bars", () => {
    expect(
      mapTouchToGuest({
        touchX: 250,
        touchY: 10,
        containerWidth: 500,
        containerHeight: 500,
        frameWidth: 1000,
        frameHeight: 500,
      }),
    ).toBeNull();
  });

  test("rejects touches before layout or frames arrive", () => {
    expect(
      mapTouchToGuest({
        touchX: 10,
        touchY: 10,
        containerWidth: 0,
        containerHeight: 0,
        frameWidth: 100,
        frameHeight: 100,
      }),
    ).toBeNull();
  });
});
