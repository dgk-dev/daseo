export type CdpCommandSender = (
  command: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Daseo delta 92. How long one queue slot may hold a tab's CDP session. A CDP command that never
 * answers used to hold the slot until the tab died, so every later screenshot, click, network,
 * CSS, and passkey command on that tab waited behind it (the same shape as Chrome DevTools MCP
 * #2426; browser-use bounds every CDP send at 60 s). Callers whose work is legitimately longer
 * (full-page capture) pass their own deadline.
 */
export const CDP_QUEUE_SLOT_TIMEOUT_MS = 10_000;

export interface CdpQueueRunOptions {
  /** What the slot runs, for the timeout message: a CDP method or a short task name. */
  label?: string;
  timeoutMs?: number;
}

export class CdpQueueTimeoutError extends Error {
  public constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `The browser tab's DevTools session did not answer ${label} within ${timeoutMs}ms; later commands on the tab no longer wait for it.`,
    );
    this.name = "CdpQueueTimeoutError";
  }
}

/**
 * Runs a tab's CDP work one task at a time. A task that outlives its deadline releases the slot
 * and its caller gets a CdpQueueTimeoutError; the task's late result is ignored.
 */
export class CdpSessionQueue {
  private queue: Promise<void> = Promise.resolve();
  private readonly defaultTimeoutMs: number;

  public constructor(options: { defaultTimeoutMs?: number } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? CDP_QUEUE_SLOT_TIMEOUT_MS;
  }

  public async run<T>(task: () => Promise<T>, options: CdpQueueRunOptions = {}): Promise<T> {
    const previous = this.queue;
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.queue = tail;

    await previous.catch(() => {});
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => task())();
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CdpQueueTimeoutError(options.label ?? "a command", timeoutMs)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      if (timer) clearTimeout(timer);
      // A task that lost the race may still settle; its result has no reader.
      work.catch(() => {});
      releaseCurrent();
      if (this.queue === tail) {
        this.queue = Promise.resolve();
      }
    }
  }
}
