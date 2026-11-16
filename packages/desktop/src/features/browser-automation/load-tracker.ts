// How long each browser target has been loading, and where to.
//
// A diagnostic clock for list_tabs and the broker's "still loading" message; Electron's
// isLoading() stays the authority on whether a tab is loading. Page scripts no longer wait for a
// load to stop (delta 92: they run through the main frame), and browser_navigate follows its own
// commit (delta 123), so this record blocks nothing.

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

/**
 * Daseo delta 123: the URL a new tab was asked to open. Its first navigation can start before main
 * observes the tab, and until it commits Electron has no URL for it: list_tabs reported `url: ""`
 * and `title: ""` for a tab whose first document took over a minute (Search Console, 2026-11-16).
 * Kept only while that load runs; a navigation main sees replaces it.
 */
export function noteRequestedTabUrl(contentsId: number, url: string): void {
  const state = loadStates.get(contentsId);
  if (state && state.navigationUrl === null && url) {
    state.navigationUrl = url;
  }
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
