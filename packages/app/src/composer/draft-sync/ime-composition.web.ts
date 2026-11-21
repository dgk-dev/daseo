/**
 * Daseo delta 139: whether an input method is composing text right now (Korean, Japanese, and
 * Chinese input compose a syllable before committing it). Re-feeding the editor's value during a
 * composition ends it and loses the syllable, so a synced draft from another device waits for
 * `compositionend`. Composition events bubble from the focused field to the document.
 */
let composing = false;
let installed = false;
const endListeners = new Set<() => void>();

function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "compositionstart",
    () => {
      composing = true;
    },
    true,
  );
  document.addEventListener(
    "compositionend",
    () => {
      composing = false;
      for (const listener of endListeners) listener();
    },
    true,
  );
}

export function isImeComposing(): boolean {
  install();
  return composing;
}

export function onImeCompositionEnd(listener: () => void): () => void {
  install();
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
}
