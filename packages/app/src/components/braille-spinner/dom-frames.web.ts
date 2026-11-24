import { uiClock } from "@/components/braille-spinner/clock";
import { BRAILLE_SPINNER_FRAMES } from "@/components/braille-spinner/frames";

// Web: the shared clock writes the frame into every mounted spinner's text node directly, so a
// tick costs one text write per visible spinner and no React render. React keeps rendering the
// first frame as the child; it only rewrites the node when that child changes (static <-> moving).
const nodes = new Set<HTMLElement>();
let unsubscribe: (() => void) | null = null;

function writeFrame(): void {
  const glyph = BRAILLE_SPINNER_FRAMES[uiClock.getFrame() % BRAILLE_SPINNER_FRAMES.length];
  for (const node of nodes) {
    if (node.textContent !== glyph) node.textContent = glyph;
  }
}

/** Animates `node` on the shared clock until the returned function runs. */
export function registerSpinnerNode(node: HTMLElement): () => void {
  nodes.add(node);
  if (unsubscribe === null) unsubscribe = uiClock.subscribeFrame(writeFrame);
  writeFrame();
  return () => {
    nodes.delete(node);
    if (nodes.size === 0 && unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}
