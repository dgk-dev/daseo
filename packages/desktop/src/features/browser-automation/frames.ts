// Daseo delta 110. Elements inside cross-origin iframes (a Stripe card form, an embedded sign-in
// widget) are out of reach of a script that runs in the tab's main frame: contentDocument is null
// for them. Each such frame runs its own copy of the snapshot, find, and action scripts through
// Electron's WebFrameMain, and its refs carry the frame (`@f1e3`, as in Playwright MCP).
//
// The host knows frames as Electron frames; the page knows them as windows. The two meet on the
// window path: from the top window down, the frame's position in its parent's `window.frames`.
// Every step of computing it (parent, frames, indexing, identity) is allowed across origins, so the
// embedder's script and the frame's own script compute the same path.

/** One frame of a tab below its main frame (Electron WebFrameMain). */
export interface TabFrame {
  /** Electron frameTreeNodeId: stays with the frame across its navigations. */
  readonly id: number;
  /** The parent frame's id; null for a child of the main frame. */
  readonly parentId: number | null;
  /**
   * The frame runs in another renderer process than its parent. Keyboard and text input reach
   * such a frame, and the frames inside it in its process, only through its own DevTools target.
   */
  readonly outOfProcess: boolean;
  readonly url: string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/** What a frame's own script answers: the frame-side half of the path match. */
export const WINDOW_PATH_SOURCE = String.raw`
  function windowIndexInParent(win) {
    const parent = win.parent;
    if (!parent || parent === win) return null;
    for (let index = 0; index < parent.frames.length; index += 1) {
      if (parent.frames[index] === win) return index;
    }
    return -1;
  }

  function windowPath(win) {
    const path = [];
    let current = win;
    for (let depth = 0; depth < 16; depth += 1) {
      const index = windowIndexInParent(current);
      if (index === null) return path;
      if (index < 0) return null;
      path.unshift(index);
      current = current.parent;
    }
    return null;
  }
`;

export const WINDOW_PATH_SCRIPT = String.raw`(() => {
  ${WINDOW_PATH_SOURCE}
  return windowPath(window);
})()`;

/**
 * The window path of the cross-origin frame that holds keyboard focus inside this document
 * (following same-origin frames and open shadow roots), or null when focus stays in reach of this
 * document's script.
 */
export const FOCUSED_FRAME_SCRIPT = String.raw`(() => {
  ${WINDOW_PATH_SOURCE}
  let active = document.activeElement;
  for (let depth = 0; active && depth < 16; depth += 1) {
    if (active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
      continue;
    }
    const tag = active.tagName ? active.tagName.toLowerCase() : '';
    if (tag !== 'iframe' && tag !== 'frame') return null;
    let doc = null;
    try {
      doc = active.contentDocument;
    } catch {
      doc = null;
    }
    if (doc) {
      active = doc.activeElement;
      continue;
    }
    let win = null;
    try {
      win = active.contentWindow;
    } catch {
      win = null;
    }
    return win ? windowPath(win) : null;
  }
  return null;
})()`;

/** Text or one key (a browser_keypress name) for an out-of-process frame. */
export type FrameInput = { kind: "text"; text: string } | { kind: "key"; key: string };

/** A frame script that gets no answer in this long is treated as unreachable. */
export const FRAME_SCRIPT_TIMEOUT_MS = 3_000;
const MAX_PATH_PROBES = 64;
const FRAME_REF_PATTERN = /^@f(\d+)(e\d+)$/;

export function frameRef(frameNumber: number, innerRef: string): string {
  return `@f${frameNumber}${innerRef.slice(1)}`;
}

export function isFrameRef(ref: string): boolean {
  return FRAME_REF_PATTERN.test(ref);
}

/** Runs a frame script; null when the frame throws or does not answer in time. */
export async function runFrameScript(
  frame: Pick<TabFrame, "executeJavaScript">,
  code: string,
  userGesture?: boolean,
  timeoutMs = FRAME_SCRIPT_TIMEOUT_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const work = frame.executeJavaScript(code, userGesture === true).catch(() => null);
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function readPath(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0)
    ? (value as number[])
    : null;
}

/**
 * The tab's frames at one moment. Paths are asked of each frame at most once, and only of frames
 * as deep as the path looked for.
 */
export class FrameLocator {
  private readonly byId = new Map<number, TabFrame>();
  private readonly paths = new Map<number, Promise<number[] | null>>();
  private probes = 0;

  public constructor(public readonly frames: readonly TabFrame[]) {
    for (const frame of frames) this.byId.set(frame.id, frame);
  }

  public get(id: number): TabFrame | null {
    return this.byId.get(id) ?? null;
  }

  public parentOf(frame: TabFrame): TabFrame | null {
    return frame.parentId === null ? null : this.get(frame.parentId);
  }

  public depthOf(frame: TabFrame): number {
    let depth = 1;
    for (let parent = this.parentOf(frame); parent && depth < 32; parent = this.parentOf(parent)) {
      depth += 1;
    }
    return depth;
  }

  /**
   * The frame whose DevTools target carries keyboard and text input for `frame`: the nearest
   * out-of-process frame at or above it. Null when every frame on the way shares the main frame's
   * renderer, where the tab's own input reaches it.
   */
  public inputRootOf(frame: TabFrame): TabFrame | null {
    for (let current: TabFrame | null = frame; current; current = this.parentOf(current)) {
      if (current.outOfProcess) return current;
    }
    return null;
  }

  public async byPath(path: readonly number[]): Promise<TabFrame | null> {
    const candidates = this.frames.filter((frame) => this.depthOf(frame) === path.length);
    const found = await Promise.all(
      candidates.map(async (frame) => {
        const framePath = await this.pathOf(frame);
        return framePath && samePath(framePath, path) ? frame : null;
      }),
    );
    return found.find((frame) => frame !== null) ?? null;
  }

  private pathOf(frame: TabFrame): Promise<number[] | null> {
    let path = this.paths.get(frame.id);
    if (!path) {
      if (this.probes >= MAX_PATH_PROBES) return Promise.resolve(null);
      this.probes += 1;
      path = runFrameScript(frame, WINDOW_PATH_SCRIPT).then(readPath);
      this.paths.set(frame.id, path);
    }
    return path;
  }
}
