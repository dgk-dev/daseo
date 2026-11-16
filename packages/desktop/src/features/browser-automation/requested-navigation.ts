// Daseo delta 123: browser_navigate answers when the navigation it started commits, not when the
// whole page has finished loading.
//
// `webContents.loadURL` settles on did-finish-load or the first main-frame did-fail-load (measured
// with Electron 44.10.2 in the capture harness group `tab-reliability`):
// - a page holding one request open forever (an image, a long poll) never finishes, so a navigate
//   to it never answered although its document committed in 3 ms; the broker then said
//   "has been loading Ns … not finished loading" (Google Search Console, 2026-11-16);
// - navigating away from such a page makes the old load fail with ERR_ABORTED (-3), and loadURL
//   rejects with that old abort although the requested page committed 1 ms later.
// So the navigate follows its own navigation: the first main-frame cross-document start after
// loadURL is called, its commit (did-navigate), and that document's dom-ready. An ERR_ABORTED of
// another load never ends it, and a commit before its start is never taken for it.

export interface RequestedNavigationCommit {
  url: string;
  response?: { httpStatus: number; httpStatusText: string };
}

export interface RequestedNavigationSource {
  isLoading(): boolean;
  isDestroyed(): boolean;
  onMainFrameNavigationStarted?(listener: (url: string, sameDocument: boolean) => void): () => void;
  onMainFrameNavigated?(
    listener: (url: string, response?: RequestedNavigationCommit["response"]) => void,
  ): () => void;
  /** Main-frame did-fail-load: the URL that failed, Chromium's net error code, its name. */
  onMainFrameLoadFailed?(
    listener: (url: string, errorCode: number, errorDescription: string) => void,
  ): () => void;
  /** dom-ready of the main frame's document. */
  onMainFrameDomReady?(listener: () => void): () => void;
  onStopLoading?(listener: () => void): () => void;
}

export type RequestedNavigationOutcome =
  /** The requested navigation committed and its document is parsed (or the load finished). */
  | { kind: "committed"; commit: RequestedNavigationCommit; loaded: boolean }
  /** loadURL resolved: the load finished (same-document moves have no commit). */
  | { kind: "loaded"; commit: RequestedNavigationCommit | null }
  /** Another main-frame navigation replaced the requested one before it committed. */
  | { kind: "superseded"; commit: RequestedNavigationCommit | null; error: unknown }
  | {
      kind: "failed";
      error: unknown;
      commit: RequestedNavigationCommit | null;
      /** The requested navigation's own net error, when Chromium reported one. */
      netError: { code: number; description: string } | null;
    };

export type RequestedNavigationLog = (
  stage: string,
  fields: Record<string, string | number | boolean | null | undefined>,
) => void;

const ERR_ABORTED = -3;

export function runRequestedNavigation(input: {
  contents: RequestedNavigationSource;
  url: string;
  load: () => Promise<void>;
  log?: RequestedNavigationLog;
  now?: () => number;
}): Promise<RequestedNavigationOutcome> {
  const { contents, url } = input;
  const now = input.now ?? Date.now;
  const log = input.log ?? (() => {});
  const startedAt = now();
  const elapsed = () => now() - startedAt;

  return new Promise<RequestedNavigationOutcome>((resolve) => {
    const unsubscribers: Array<() => void> = [];
    let done = false;
    let loadCalled = false;
    let ownStart: string | null = null;
    let ownSameDocument = false;
    let supersededBy: string | null = null;
    let commit: RequestedNavigationCommit | null = null;
    let laterCommit: RequestedNavigationCommit | null = null;
    let ownFailure: { url: string; code: number; description: string } | null = null;
    let loadError: { error: unknown } | null = null;
    let loadResolvedEarly = false;

    const finish = (outcome: RequestedNavigationOutcome): void => {
      if (done) return;
      done = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      log("outcome", {
        kind: outcome.kind,
        ms: elapsed(),
        url: outcome.commit?.url ?? url,
        httpStatus: outcome.commit?.response?.httpStatus,
        ...(outcome.kind === "failed" && outcome.netError ? { code: outcome.netError.code } : {}),
      });
      resolve(outcome);
    };

    const failed = (error: unknown): void => {
      finish({
        kind: "failed",
        error,
        commit,
        netError: ownFailure
          ? { code: ownFailure.code, description: ownFailure.description }
          : null,
      });
    };

    // A navigation still on its way to a commit: it started, nothing replaced it, and the tab is
    // still loading.
    const ownStillPending = (): boolean =>
      ownStart !== null &&
      !ownSameDocument &&
      commit === null &&
      supersededBy === null &&
      ownFailure === null &&
      !contents.isDestroyed() &&
      contents.isLoading();

    const settleAfterLoadError = (error: unknown): void => {
      if (commit) {
        // An abort after our commit is a redirect or script navigation taking over; any other
        // error means the committed document itself failed to load.
        if (isAbortError(error)) finish({ kind: "committed", commit, loaded: false });
        else failed(error);
        return;
      }
      if (supersededBy !== null) {
        finish({ kind: "superseded", commit: laterCommit, error });
        return;
      }
      if (ownStillPending()) {
        // The abort of the load this navigation replaced; keep following our own navigation.
        log("load-rejected-ignored", { ms: elapsed(), reason: errorText(error) });
        return;
      }
      failed(error);
    };

    const add = (unsubscribe: (() => void) | undefined): void => {
      if (unsubscribe) unsubscribers.push(unsubscribe);
    };

    add(
      contents.onMainFrameNavigationStarted?.((startedUrl, sameDocument) => {
        if (done || !loadCalled) return;
        if (ownStart === null) {
          ownStart = startedUrl;
          ownSameDocument = sameDocument;
          log("did-start-navigation", {
            ms: elapsed(),
            url: startedUrl,
            sameDocument,
          });
          return;
        }
        if (!sameDocument && commit === null && supersededBy === null && !ownSameDocument) {
          supersededBy = startedUrl;
          log("superseded", { ms: elapsed(), url: startedUrl });
        }
      }),
    );
    add(
      contents.onMainFrameNavigated?.((committedUrl, response) => {
        if (done || ownStart === null) return;
        const committed = { url: committedUrl, ...(response ? { response } : {}) };
        if (supersededBy !== null) {
          laterCommit = committed;
          log("commit-superseding", { ms: elapsed(), url: committedUrl });
          finish({ kind: "superseded", commit: laterCommit, error: null });
          return;
        }
        if (commit === null && !ownSameDocument) {
          commit = committed;
          log("commit", {
            ms: elapsed(),
            url: committedUrl,
            httpStatus: response?.httpStatus,
          });
        }
      }),
    );
    add(
      contents.onMainFrameDomReady?.(() => {
        if (done || commit === null) return;
        log("dom-ready", { ms: elapsed() });
        finish({ kind: "committed", commit, loaded: false });
      }),
    );
    add(
      contents.onMainFrameLoadFailed?.((failedUrl, code, description) => {
        if (done || ownStart === null) return;
        log("did-fail-load", { ms: elapsed(), url: failedUrl, code, description });
        // An abort is what Chromium reports for the load a new navigation replaced, and for a
        // navigation that became a download; neither ends the wait here. The stop or loadURL
        // settling decides.
        if (code === ERR_ABORTED || commit !== null || supersededBy !== null) return;
        ownFailure = { url: failedUrl, code, description };
      }),
    );
    add(
      contents.onStopLoading?.(() => {
        if (done || ownStart === null) return;
        log("did-stop-loading", { ms: elapsed() });
        if (commit !== null) return;
        // A load that stopped without our commit: loadURL's own stop listener runs after this
        // one, so let it reject first, then decide.
        setTimeout(() => {
          if (done) return;
          if (loadError) {
            settleAfterLoadError(loadError.error);
            if (!done && !contents.isLoading()) failed(loadError.error);
          } else if (loadResolvedEarly && !ownFailure && !contents.isLoading()) {
            finish({ kind: "loaded", commit: laterCommit });
          } else if (ownFailure && !contents.isLoading()) {
            failed(new Error(`${ownFailure.description || "net error"} (${ownFailure.code})`));
          }
        }, 0);
      }),
    );

    log("loadURL", { url });
    loadCalled = true;
    // A source that reports no navigation starts: whatever commits after loadURL is ours.
    if (!contents.onMainFrameNavigationStarted) ownStart = url;
    let loading: Promise<void>;
    try {
      loading = input.load();
    } catch (error) {
      loadError = { error };
      failed(error);
      return;
    }
    const onLoadResolved = (): void => {
      if (done) return;
      if (commit) {
        finish({ kind: "committed", commit, loaded: true });
        return;
      }
      if (ownStillPending()) {
        // loadURL resolves on any did-finish-load after the start, including the one of the page
        // this navigation replaces when that page was still finishing (measured: a navigate right
        // after one that answered at dom-ready resolved in 0 ms, uncommitted).
        loadResolvedEarly = true;
        log("load-resolved-ignored", { ms: elapsed() });
        return;
      }
      finish({ kind: "loaded", commit: laterCommit });
    };
    void (async () => {
      try {
        await loading;
      } catch (error) {
        loadError = { error };
        if (!done) settleAfterLoadError(error);
        return;
      }
      onLoadResolved();
    })();
  });
}

function isAbortError(error: unknown): boolean {
  // Electron leaves the name empty for some aborts (" (-3) loading '…'").
  return /(^|\s|ERR_ABORTED )\(-3\)/.test(errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
