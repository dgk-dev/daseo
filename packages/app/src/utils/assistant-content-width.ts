// Daseo delta 89: the transcript spans the pane instead of a fixed 820px column, so the width a
// height estimate assumes is the width the last assistant markdown block was measured at. The
// web history list virtualizes off-screen rows with these estimates; a fixed width would miss
// every cached height and make the list jump.
let lastMeasuredWidth: number | null = null;

export function recordAssistantContentWidth(width: number): void {
  lastMeasuredWidth = width;
}

export function getAssistantContentWidth(): number | null {
  return lastMeasuredWidth;
}

export function clearAssistantContentWidth(): void {
  lastMeasuredWidth = null;
}
