import { describe, expect, test } from "vitest";
import { AgentDownloads, type DownloadItemLike, type DownloadState } from "./downloads.js";
import { BrowserTabEventQueue } from "./tab-events.js";

class FakeItem implements DownloadItemLike {
  public savePath = "";
  public received = 0;
  private doneListener: ((event: unknown, state: DownloadState) => void) | null = null;

  public constructor(
    private readonly name: string,
    private readonly total = 10,
  ) {}

  public getFilename(): string {
    return this.name;
  }
  public getURL(): string {
    return `https://files.example.com/${this.name}`;
  }
  public getTotalBytes(): number {
    return this.total;
  }
  public getReceivedBytes(): number {
    return this.received;
  }
  public setSavePath(savePath: string): void {
    this.savePath = savePath;
  }
  public once(_event: "done", listener: (event: unknown, state: DownloadState) => void): void {
    this.doneListener = listener;
  }
  public finish(state: DownloadState = "completed"): void {
    this.received = state === "completed" ? this.total : 3;
    this.doneListener?.({}, state);
  }
}

function setup(existing: string[] = []) {
  const events = new BrowserTabEventQueue();
  const made: string[] = [];
  const downloads = new AgentDownloads({
    directory: () => "/Users/me/Downloads/Daseo",
    events,
    exists: (filePath) => existing.includes(filePath),
    makeDirectory: (dir) => made.push(dir),
  });
  return { downloads, events, made };
}

describe("AgentDownloads", () => {
  test("saves without a dialog to a unique path and reports start and finish", async () => {
    const { downloads, events, made } = setup(["/Users/me/Downloads/Daseo/report.pdf"]);
    const item = new FakeItem("report.pdf");
    downloads.handle({ item, contentsIds: [7], browserId: "tab-a" });
    expect(made).toEqual(["/Users/me/Downloads/Daseo"]);
    expect(item.savePath).toBe("/Users/me/Downloads/Daseo/report (1).pdf");

    const second = new FakeItem("report.pdf");
    downloads.handle({ item: second, contentsIds: [7], browserId: "tab-a" });
    expect(second.savePath).toBe("/Users/me/Downloads/Daseo/report (2).pdf");

    item.finish();
    const delivered = events.drain({ browserId: "tab-a" });
    expect(delivered.map((event) => event.type)).toEqual([
      "download_started",
      "download_started",
      "download_finished",
    ]);
    expect(delivered[2]?.download).toMatchObject({
      fileName: "report (1).pdf",
      path: "/Users/me/Downloads/Daseo/report (1).pdf",
      state: "completed",
      receivedBytes: 10,
    });
  });

  test("a wait returns a download that already finished, then waits for the next one", async () => {
    const { downloads } = setup();
    const quick = new FakeItem("a.csv");
    downloads.handle({ item: quick, contentsIds: [7], browserId: "tab-a" });
    quick.finish();
    await expect(downloads.waitForDownload(7, 1_000)).resolves.toMatchObject({
      fileName: "a.csv",
      state: "completed",
    });

    const next = downloads.waitForDownload(7, 1_000);
    const later = new FakeItem("b.csv");
    downloads.handle({ item: later, contentsIds: [7], browserId: "tab-a" });
    later.finish("interrupted");
    await expect(next).resolves.toMatchObject({ fileName: "b.csv", state: "interrupted" });

    await expect(downloads.waitForDownload(7, 20)).resolves.toBeNull();
  });

  test("a popup's download can be awaited on the tab that opened it", async () => {
    const { downloads } = setup();
    const waiting = downloads.waitForDownload(3, 1_000);
    const item = new FakeItem("../../etc/passwd");
    downloads.handle({ item, contentsIds: [9, 3], browserId: "popup-1" });
    // A name can never leave the folder.
    expect(item.savePath).toBe("/Users/me/Downloads/Daseo/.._.._etc_passwd");
    item.finish();
    await expect(waiting).resolves.toMatchObject({ fileName: ".._.._etc_passwd" });
  });
});
