import { describe, expect, test } from "vitest";
import {
  DEFAULT_DASEO_CODESIGN_IDENTITY,
  assertCodeSigningIdentityAvailable,
  hasCodeSigningIdentity,
} from "./daseo-code-sign.mjs";

const IDENTITIES = `
  1) BE068C1970042D793E022A370C18175C74E9BCD3 "Daseo Local Code Signing"
     1 valid identities found
`;

describe("Daseo stable local code signing", () => {
  test("recognizes the exact configured identity", () => {
    expect(hasCodeSigningIdentity(IDENTITIES, DEFAULT_DASEO_CODESIGN_IDENTITY)).toBe(true);
    expect(hasCodeSigningIdentity(IDENTITIES, "Daseo")).toBe(false);
  });

  test("accepts the stable identity", () => {
    expect(() =>
      assertCodeSigningIdentityAvailable({
        output: IDENTITIES,
        identity: DEFAULT_DASEO_CODESIGN_IDENTITY,
      }),
    ).not.toThrow();
  });

  test("refuses to silently fall back to ad-hoc signing", () => {
    expect(() =>
      assertCodeSigningIdentityAvailable({
        output: "0 valid identities found",
        identity: DEFAULT_DASEO_CODESIGN_IDENTITY,
      }),
    ).toThrow(/Refusing ad-hoc signing/);
  });
});
