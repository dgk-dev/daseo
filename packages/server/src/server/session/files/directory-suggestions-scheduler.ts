export class DirectorySuggestionsSupersededError extends Error {
  public constructor() {
    super("Superseded by a newer directory suggestions request");
    this.name = "DirectorySuggestionsSupersededError";
  }
}

/**
 * Runs one session's directory searches one at a time. A search that names a supersede group
 * (typeahead: each keystroke replaces the last query) aborts the group's running or queued
 * search; searches without a group (file-link lookups, where every click is its own intent) are
 * never cancelled, only queued. Each search can read up to its read budget, so running them
 * serially is what keeps a burst of hover prefetches from multiplying daemon heap.
 */
export class DirectorySuggestionsScheduler {
  private tail: Promise<void> = Promise.resolve();
  private readonly latestByGroup = new Map<string, AbortController>();
  private readonly controllers = new Set<AbortController>();

  public run<T>(
    supersedeGroup: string | null,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    if (supersedeGroup !== null) {
      this.latestByGroup.get(supersedeGroup)?.abort(new DirectorySuggestionsSupersededError());
      this.latestByGroup.set(supersedeGroup, controller);
    }
    this.controllers.add(controller);
    const result = this.tail.then(() => {
      controller.signal.throwIfAborted();
      return task(controller.signal);
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.controllers.delete(controller);
      if (supersedeGroup !== null && this.latestByGroup.get(supersedeGroup) === controller) {
        this.latestByGroup.delete(supersedeGroup);
      }
    });
  }

  public dispose(): void {
    for (const controller of this.controllers) {
      controller.abort(new DirectorySuggestionsSupersededError());
    }
    this.controllers.clear();
    this.latestByGroup.clear();
  }
}
