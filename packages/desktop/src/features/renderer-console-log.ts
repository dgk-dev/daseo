// electron-log's defaults reach every session and every WebContents: its preload registers on each
// session as it is created, and its console spy listens to each WebContents. The browser profile is
// a session too, so every site page and cross-origin frame ran the preload, which exposes
// `window.__electronLog` to the page, and every site's console went into Daseo's log file. Both
// stay on Daseo's own renderer.

interface ElectronLogInitializeOptions {
  getSessions: () => object[];
  includeFutureSession: false;
  includeFutureSessions: false;
  preload: true;
  spyRendererConsole: false;
}

/**
 * electron-log 5.4 reads `includeFutureSession` at runtime while its typings name the option
 * `includeFutureSessions`; both are set so the browser profile, created after app ready, never
 * gets the preload whichever name a later release reads.
 */
export function electronLogInitializeOptions(
  getAppSessions: () => object[],
): ElectronLogInitializeOptions {
  return {
    getSessions: getAppSessions,
    includeFutureSession: false,
    includeFutureSessions: false,
    preload: true,
    spyRendererConsole: false,
  };
}

type RendererLogLevel = "debug" | "info" | "warn" | "error";

// Older Electron releases put a number on the event: verbose, info, warning, error.
const NUMERIC_LEVELS: readonly RendererLogLevel[] = ["debug", "info", "warn", "error"];

interface ConsoleMessageEvent {
  level?: unknown;
  message?: unknown;
}

interface ConsoleWebContents {
  readonly session: object;
  on(event: "console-message", listener: (event: ConsoleMessageEvent) => void): unknown;
}

interface WebContentsCreatedSource {
  on(
    event: "web-contents-created",
    listener: (event: unknown, contents: ConsoleWebContents) => void,
  ): unknown;
}

interface RendererConsoleLogger {
  processMessage(message: {
    data: unknown[];
    date: Date;
    level: RendererLogLevel;
    variables: { processType: "renderer" };
  }): void;
}

export function rendererConsoleLevel(event: ConsoleMessageEvent): RendererLogLevel {
  if (event.level === "warning") return "warn";
  if (event.level === "debug" || event.level === "info" || event.level === "error") {
    return event.level;
  }
  return (typeof event.level === "number" ? NUMERIC_LEVELS[event.level] : undefined) ?? "info";
}

/**
 * The console spy electron-log's `spyRendererConsole` provided, minus browser profile pages
 * (webviews and their popups). Register before any window exists.
 */
export function forwardAppRendererConsole(input: {
  app: WebContentsCreatedSource;
  logger: RendererConsoleLogger;
  isBrowserProfileSession(session: object): boolean;
}): void {
  input.app.on("web-contents-created", (_event, contents) => {
    if (input.isBrowserProfileSession(contents.session)) return;
    // The event object only: Electron 41 warns once a listener takes the deprecated positional
    // arguments.
    contents.on("console-message", (event) => {
      input.logger.processMessage({
        data: [event.message],
        date: new Date(),
        level: rendererConsoleLevel(event),
        variables: { processType: "renderer" },
      });
    });
  });
}
