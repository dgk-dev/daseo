import type { SyntaxColors } from "@getpaseo/highlight";

// Daseo delta 89: syntax palettes are authored for their own editor backgrounds. On the Daseo
// theme's aubergine code surface some tokens (One Dark's comment #5c6370 is 2.6:1) drop below
// WCAG AA, so a token under 4.5:1 is mixed toward white until it reaches 4.5:1. Tokens that
// already pass keep their exact colour, so each palette still reads as itself.
const CONTRAST_FLOOR = 4.5;
const MIX_STEP = 0.02;

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const first = parseHex(a);
  const second = parseHex(b);
  if (!first || !second) return Number.NaN;
  const x = relativeLuminance(first);
  const y = relativeLuminance(second);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function liftColor(color: string, background: string): string {
  const rgb = parseHex(color);
  if (!rgb || contrastRatio(color, background) >= CONTRAST_FLOOR) return color;
  for (let amount = MIX_STEP; amount <= 1; amount += MIX_STEP) {
    const mixed = toHex([
      rgb[0] + (255 - rgb[0]) * amount,
      rgb[1] + (255 - rgb[1]) * amount,
      rgb[2] + (255 - rgb[2]) * amount,
    ]);
    if (contrastRatio(mixed, background) >= CONTRAST_FLOOR) return mixed;
  }
  return "#ffffff";
}

export function liftSyntaxContrast(syntax: SyntaxColors, background: string): SyntaxColors {
  const lifted = { ...syntax };
  for (const key of Object.keys(lifted) as (keyof SyntaxColors)[]) {
    lifted[key] = liftColor(lifted[key], background);
  }
  return lifted;
}
