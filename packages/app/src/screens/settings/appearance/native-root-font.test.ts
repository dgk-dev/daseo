import { afterEach, describe, expect, it } from "vitest";
import { nativeRootFontFamily, setNativeRootFont } from "./native-root-font";

describe("native root interface font (delta 53)", () => {
  afterEach(() => {
    globalThis.__daseoDefaultFontFamily = undefined;
  });

  it("uses the first family of a stack, unquoted", () => {
    expect(nativeRootFontFamily("D2Coding")).toBe("D2Coding");
    expect(nativeRootFontFamily("'Pretendard Variable', Pretendard, system-ui")).toBe(
      "Pretendard Variable",
    );
    expect(nativeRootFontFamily(' "D2Coding" , monospace')).toBe("D2Coding");
  });

  it("leaves the platform face alone for system families and empty input", () => {
    for (const stack of ["normal", "system-ui", "sans-serif", "", "  "]) {
      expect(nativeRootFontFamily(stack)).toBeUndefined();
    }
  });

  it("publishes the family the patched Text and TextInput read", () => {
    setNativeRootFont("D2Coding");
    expect(globalThis.__daseoDefaultFontFamily).toBe("D2Coding");
    setNativeRootFont("normal");
    expect(globalThis.__daseoDefaultFontFamily).toBeUndefined();
  });
});
