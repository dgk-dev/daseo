// Daseo delta 51: one motion scale for app-authored animation. Small, frequent
// feedback (tooltips, menus, hover rails) is fast; state changes that move more
// (switches, fades of whole rows, border transitions) take the base duration; exits
// are quicker than entrances. Easing is Material 3's standard curve: fast out of the
// gate, settling softly, never ease-in.
export const MOTION_DURATION_MS = {
  fast: 120,
  base: 180,
  exit: 100,
} as const;

// Plain numbers so this module loads without Reanimated; pass them to Easing.bezier.
export const MOTION_EASING_BEZIER = [0.2, 0, 0, 1] as const;

export const MOTION_EASING_CSS = `cubic-bezier(${MOTION_EASING_BEZIER.join(", ")})`;
