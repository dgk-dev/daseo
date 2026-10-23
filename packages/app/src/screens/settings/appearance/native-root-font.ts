// Daseo delta 53: the family the patched React Native Text and TextInput fall back to
// (patches/react-native+0.81.5.patch). Platform-free so tests and both builds share it.
const SYSTEM_FAMILIES = new Set(["normal", "system", "system-ui", "sans-serif", "-apple-system"]);

declare global {
  // eslint-disable-next-line no-var
  var __daseoDefaultFontFamily: string | undefined;
}

/** First family of a CSS-like stack, unquoted; undefined for the platform's own face. */
export function nativeRootFontFamily(uiFontStack: string): string | undefined {
  const first =
    uiFontStack
      .split(",")[0]
      ?.trim()
      .replace(/^["']|["']$/g, "") ?? "";
  if (!first || SYSTEM_FAMILIES.has(first.toLowerCase())) return undefined;
  return first;
}

export function setNativeRootFont(uiFontStack: string): void {
  globalThis.__daseoDefaultFontFamily = nativeRootFontFamily(uiFontStack);
}
