import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserAutomationDownload } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserTabEventQueue } from "./tab-events.js";

// Daseo delta 92. A download in a browser tab used to open the macOS save dialog, and the agent
// that clicked the link learned nothing. A download an agent-driven tab starts is saved without a
// dialog to ~/Downloads/Daseo/<unique name>, reported as tab events, and can be awaited with
// browser_wait download (agent-browser's `wait --download`). Downloads a person starts by hand keep
// the save dialog.

export type DownloadState = BrowserAutomationDownload["state"];

/** The part of Electron's DownloadItem this needs. */
export interface DownloadItemLike {
  getFilename(): string;
  getURL(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  setSavePath(savePath: string): void;
  once(event: "done", listener: (event: unknown, state: DownloadState) => void): unknown;
}

interface DownloadRecord {
  download: BrowserAutomationDownload;
  done: Promise<BrowserAutomationDownload>;
  claimed: boolean;
}

interface NextWaiter {
  resolve: (record: DownloadRecord) => void;
}

const MAX_RECORDS_PER_TAB = 20;

export class AgentDownloads {
  private readonly recordsByContentsId = new Map<number, DownloadRecord[]>();
  private readonly nextWaitersByContentsId = new Map<number, NextWaiter[]>();
  private readonly reservedPaths = new Set<string>();

  public constructor(
    private readonly options: {
      directory: () => string;
      events?: BrowserTabEventQueue;
      exists?: (filePath: string) => boolean;
      makeDirectory?: (directory: string) => void;
    },
  ) {}

  /**
   * Takes over a download an agent-driven tab started: no dialog, a unique path, events.
   * `contentsIds` is the tab and the tabs that opened it (a popup's download can be awaited on the
   * tab whose click opened the popup).
   */
  public handle(input: {
    item: DownloadItemLike;
    contentsIds: readonly number[];
    browserId: string | null;
  }): void {
    const { item, contentsIds, browserId } = input;
    const directory = this.options.directory();
    (this.options.makeDirectory ?? ((dir) => mkdirSync(dir, { recursive: true })))(directory);
    const savePath = this.uniquePath(directory, safeFileName(item.getFilename()));
    item.setSavePath(savePath);
    this.reservedPaths.add(savePath);

    const download: BrowserAutomationDownload = {
      fileName: path.basename(savePath),
      path: savePath,
      url: item.getURL(),
      state: "progressing",
      receivedBytes: 0,
      ...(item.getTotalBytes() > 0 ? { totalBytes: item.getTotalBytes() } : {}),
    };
    const done = new Promise<BrowserAutomationDownload>((resolve) => {
      item.once("done", (_event, state) => {
        this.reservedPaths.delete(savePath);
        download.state = state;
        download.receivedBytes = item.getReceivedBytes();
        if (item.getTotalBytes() > 0) download.totalBytes = item.getTotalBytes();
        if (browserId) {
          this.options.events?.record(browserId, {
            type: state === "completed" ? "download_finished" : "download_failed",
            download: { ...download },
          });
        }
        resolve({ ...download });
      });
    });
    const record: DownloadRecord = { download, done, claimed: false };
    for (const contentsId of contentsIds) {
      const records = this.recordsByContentsId.get(contentsId) ?? [];
      records.push(record);
      if (records.length > MAX_RECORDS_PER_TAB) {
        records.splice(0, records.length - MAX_RECORDS_PER_TAB);
      }
      this.recordsByContentsId.set(contentsId, records);
    }
    if (browserId) {
      this.options.events?.record(browserId, {
        type: "download_started",
        download: { ...download },
      });
    }
    for (const contentsId of contentsIds) {
      const waiter = this.nextWaitersByContentsId.get(contentsId)?.shift();
      if (waiter) {
        record.claimed = true;
        waiter.resolve(record);
        break;
      }
    }
  }

  /**
   * The tab's oldest download no wait has returned yet (in progress or finished), else the next
   * one it starts; resolves when that download is done, or null at the deadline.
   */
  public async waitForDownload(
    contentsId: number,
    timeoutMs: number,
  ): Promise<BrowserAutomationDownload | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const pending = this.recordsByContentsId.get(contentsId)?.find((record) => !record.claimed);
    let waiter: NextWaiter | null = null;
    const record = pending
      ? Promise.resolve(pending)
      : new Promise<DownloadRecord>((resolve) => {
          waiter = { resolve };
          const waiters = this.nextWaitersByContentsId.get(contentsId) ?? [];
          waiters.push(waiter);
          this.nextWaitersByContentsId.set(contentsId, waiters);
        });
    if (pending) pending.claimed = true;
    try {
      return await Promise.race([record.then((found) => found.done), expired]);
    } finally {
      if (timer) clearTimeout(timer);
      if (waiter) {
        const waiters = this.nextWaitersByContentsId.get(contentsId);
        const index = waiters?.indexOf(waiter) ?? -1;
        if (waiters && index >= 0) waiters.splice(index, 1);
      }
    }
  }

  public forget(contentsId: number): void {
    this.recordsByContentsId.delete(contentsId);
    this.nextWaitersByContentsId.delete(contentsId);
  }

  private uniquePath(directory: string, fileName: string): string {
    const exists = this.options.exists ?? existsSync;
    const extension = path.extname(fileName);
    const stem = fileName.slice(0, fileName.length - extension.length) || "download";
    for (let index = 0; ; index += 1) {
      const candidate = path.join(
        directory,
        index === 0 ? `${stem}${extension}` : `${stem} (${index})${extension}`,
      );
      if (!exists(candidate) && !this.reservedPaths.has(candidate)) return candidate;
    }
  }
}

function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = path.basename(name.replace(/[\u0000-\u001f/\\:]/g, "_")).trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

let activeDownloads: AgentDownloads | null = null;

export function setPaseoBrowserAgentDownloads(downloads: AgentDownloads | null): void {
  activeDownloads = downloads;
}

export function getPaseoBrowserAgentDownloads(): AgentDownloads | null {
  return activeDownloads;
}
