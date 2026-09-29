// How long each browser target has been loading, and where to.
//
// A tab that never finishes loading blocks every tab-scoped tool: Electron's
// executeJavaScript waits for the load to stop, so snapshot, click, evaluate,
// and the rest time out with no hint why (2026-09-29: a Cafe24 admin tab
// stayed loading for over 3 minutes). The broker reads this through
// browser_list_tabs to tell the agent the tab is still loading.

export interface LoadingEventSource {
  readonly id: number;
  isLoading(): boolean;
  onStartLoading(listener: () => void): void;
  onStopLoading(listener: () => void): void;
  /** Main-frame, cross-document navigations only. */
  onStartMainFrameNavigation(listener: (url: string) => void): void;
  onDestroyed(listener: () => void): void;
}

export interface TabLoadingInfo {
  loadingForMs: number;
  /** URL of the navigation in flight, when one started while observed. */
  url: string | null;
}

interface LoadState {
  startedAt: number | null;
  navigationUrl: string | null;
}

const loadStates = new Map<number, LoadState>();

export function observeTabLoading(source: LoadingEventSource, now: () => number = Date.now): void {
  if (loadStates.has(source.id)) {
    return;
  }
  const state: LoadState = { startedAt: source.isLoading() ? now() : null, navigationUrl: null };
  loadStates.set(source.id, state);
  source.onStartLoading(() => {
    // A navigation that starts while the previous one is still loading does not
    // restart the clock: the tab has been unusable since the first one.
    state.startedAt ??= now();
  });
  source.onStopLoading(() => {
    state.startedAt = null;
    state.navigationUrl = null;
  });
  source.onStartMainFrameNavigation((url) => {
    state.navigationUrl = url;
  });
  source.onDestroyed(() => loadStates.delete(source.id));
}

export function tabLoadingInfo(
  contentsId: number,
  isLoading: boolean,
  now: () => number = Date.now,
): TabLoadingInfo | null {
  const state = loadStates.get(contentsId);
  if (!isLoading || !state) {
    return null;
  }
  // Loading without an observed start (it began before observation): count
  // from the first time it was seen.
  state.startedAt ??= now();
  return { loadingForMs: Math.max(0, now() - state.startedAt), url: state.navigationUrl };
}
