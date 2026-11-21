/**
 * Daseo delta 139: whether an input method is composing text right now. React Native exposes no
 * composition events, so native reports false and the synced-draft deferral relies on its
 * "typed in the last 2 s" rule there (Android keyboards report every composing keystroke as a
 * text change).
 */
export function isImeComposing(): boolean {
  return false;
}

export function onImeCompositionEnd(_listener: () => void): () => void {
  return () => undefined;
}
