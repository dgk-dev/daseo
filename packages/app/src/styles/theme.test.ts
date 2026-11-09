import { describe, expect, it } from "vitest";
import { contrastRatio } from "./syntax-contrast";
import {
  darkDaseoTheme,
  darkPureBlackTheme,
  darkTokyoNightTheme,
  getNextThemePreference,
  THEME_OPTIONS,
} from "./theme";

describe("Theme catalog", () => {
  it("owns the picker and shortcut order", () => {
    expect(THEME_OPTIONS.map((option) => option.name)).toEqual([
      "light",
      "dark",
      "auto",
      "zinc",
      "midnight",
      "claude",
      "ghostty",
      "pureBlack",
      "daseo",
      "tokyo-night",
    ]);
    expect(getNextThemePreference("dark")).toBe("auto");
    expect(getNextThemePreference("pureBlack")).toBe("daseo");
    expect(getNextThemePreference("daseo")).toBe("tokyo-night");
    expect(getNextThemePreference("tokyo-night")).toBe("light");
  });
});

describe("Pure black theme", () => {
  it("uses a pure black application and terminal background", () => {
    expect(darkPureBlackTheme.colors.surface0).toBe("#000000");
    expect(darkPureBlackTheme.colors.background).toBe("#000000");
    expect(darkPureBlackTheme.colors.terminal.background).toBe("#000000");
  });

  it("uses Paseo's muted green accent", () => {
    expect(darkPureBlackTheme.colors.accent).toBe("#20744A");
    expect(darkPureBlackTheme.colors.accentBright).toBe("#7ccba0");
  });

  it("keeps selected sidebar rows distinct from the black sidebar", () => {
    expect(darkPureBlackTheme.colors.surfaceSidebar).toBe("#000000");
    expect(darkPureBlackTheme.colors.surfaceSidebarHover).toBe("#161616");
  });

  it("keeps ANSI black output readable on its zero-luminance terminal background", () => {
    expect(darkPureBlackTheme.colors.terminal.black).toBe("#595959");
    expect(darkPureBlackTheme.colors.terminal.brightBlack).toBe("#8a8a8a");
  });
});

describe("Daseo theme (Ubuntu aubergine)", () => {
  const colors = darkDaseoTheme.colors;

  it("paints the chat in the Ubuntu terminal background and the chrome a darker step", () => {
    expect(colors.surface1).toBe("#300A24");
    expect(colors.terminal.background).toBe("#300A24");
    expect(colors.surfaceSidebar).toBe("#26071C");
    expect(colors.surface0).toBe("#26071C");
  });

  it("meets the contrast floors on the chat background", () => {
    expect(contrastRatio(colors.foreground, colors.surface1)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(colors.foregroundMuted, colors.surface1)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.accent, colors.surface1)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.accentForeground, colors.accent)).toBeGreaterThanOrEqual(4.5);
    // Errors and the faintest captions stay readable on the chat, sidebar and code backgrounds.
    for (const surface of [colors.surface0, colors.surface1, colors.surface2]) {
      expect(contrastRatio(colors.destructive, surface)).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of [colors.surface0, colors.surface1]) {
      expect(contrastRatio(colors.foregroundExtraMuted, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses the Tango palette in the integrated terminal", () => {
    expect(colors.terminal.green).toBe("#4E9A06");
    expect(colors.terminal.brightGreen).toBe("#8AE234");
    expect(colors.terminal.cursor).toBe(colors.accent);
  });

  it("keeps square corners", () => {
    expect(darkDaseoTheme.borderRadius.full).toBe(0);
  });

  it("matches the Android block cursor, which is fixed at build time", () => {
    const { BLOCK_CURSOR_DRAWABLE_XML } = require("../../plugins/with-android-block-cursor");
    const accent = colors.accent.replace("#", "").toUpperCase();
    expect(BLOCK_CURSOR_DRAWABLE_XML).toContain(`android:color="#B3${accent}"`);
  });
});

describe("Tokyo Night theme", () => {
  it("keeps the delta 55 Daseo palette and square corners", () => {
    expect(darkTokyoNightTheme.colors.surface1).toBe("#1a1b26");
    expect(darkTokyoNightTheme.colors.accent).toBe("#7aa2f7");
    expect(darkTokyoNightTheme.colors.foreground).toBe("#c0caf5");
    expect(darkTokyoNightTheme.borderRadius.md).toBe(0);
  });
});
