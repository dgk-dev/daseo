import { describe, expect, test } from "vitest";
import { parseFootprintReport } from "./renderer-footprint.js";

describe("parseFootprintReport", () => {
  test("maps each reported process to its footprint in bytes", () => {
    const report = {
      processes: [
        { pid: 1493, name: "Paseo Helper (Renderer)", footprint: 358254632 },
        { pid: 2518, name: "Paseo Helper (Renderer)", footprint: 177129608 },
      ],
    };
    expect(parseFootprintReport(report)).toEqual(
      new Map([
        [1493, 358254632],
        [2518, 177129608],
      ]),
    );
  });

  test("leaves out entries it cannot read instead of guessing", () => {
    const report = {
      processes: [
        { pid: 7, footprint: "12 MB" },
        { pid: 0, footprint: 1 },
        { footprint: 1 },
        null,
        { pid: 9, footprint: 4096 },
      ],
    };
    expect(parseFootprintReport(report)).toEqual(new Map([[9, 4096]]));
    expect(parseFootprintReport({})).toEqual(new Map());
    expect(parseFootprintReport(null)).toEqual(new Map());
  });
});
