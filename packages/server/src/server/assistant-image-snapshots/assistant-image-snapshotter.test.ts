import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { AssistantImageSnapshotStore } from "./assistant-image-snapshot-store.js";
import { AssistantImageSnapshotter } from "./assistant-image-snapshotter.js";

let workDir: string;
let store: AssistantImageSnapshotStore;
let snapshotter: AssistantImageSnapshotter;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "assistant-image-snapshots-"));
  store = new AssistantImageSnapshotStore({
    rootDir: path.join(workDir, "paseo-home", "assistant-images"),
    maxImageBytes: 64,
  });
  snapshotter = new AssistantImageSnapshotter(store);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function assistant(text: string): AgentTimelineItem {
  return { type: "assistant_message", text };
}

function textOf(item: AgentTimelineItem): string {
  if (item.type !== "assistant_message") {
    throw new Error(`expected an assistant message, got ${item.type}`);
  }
  return item.text;
}

/** The local path the single image of a rewritten message points at. */
function imagePathOf(item: AgentTimelineItem): string {
  const match = textOf(item).match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (!match) {
    throw new Error(`no image in ${textOf(item)}`);
  }
  const source = match[1];
  return source.startsWith("file:") ? decodeURIComponent(new URL(source).pathname) : source;
}

function emit(input: {
  agentId?: string;
  text: string;
  mode?: "live" | "history";
  timestamp?: string;
}): AgentTimelineItem {
  return snapshotter.rewriteItem({
    agentId: input.agentId ?? "agent-1",
    cwd: workDir,
    item: assistant(input.text),
    mode: input.mode ?? "live",
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
  });
}

describe("AssistantImageSnapshotter", () => {
  test("an overwritten source still shows the bytes from when the message was emitted", () => {
    const screenshot = path.join(workDir, "shot.png");
    writeFileSync(screenshot, "first picture");

    const first = emit({ text: `Here: ![shot](${screenshot})` });
    writeFileSync(screenshot, "second picture");
    const second = emit({ text: `Again: ![shot](${screenshot})` });

    expect(imagePathOf(first)).not.toBe(screenshot);
    expect(readFileSync(imagePathOf(first), "utf8")).toBe("first picture");
    expect(readFileSync(imagePathOf(second), "utf8")).toBe("second picture");
  });

  test("a deleted source still shows after emission", () => {
    const screenshot = path.join(workDir, "gone.png");
    writeFileSync(screenshot, "picture");
    const item = emit({ text: `![gone](${pathToFileURL(screenshot).href})` });
    unlinkSync(screenshot);

    expect(readFileSync(imagePathOf(item), "utf8")).toBe("picture");
  });

  test("history rebuilt from the provider resolves each message to its own snapshot", () => {
    const screenshot = path.join(workDir, "shot.png");
    writeFileSync(screenshot, "first picture");
    emit({ text: `![shot](${screenshot})`, timestamp: "2026-11-16T01:00:00.000Z" });
    writeFileSync(screenshot, "second picture");
    emit({ text: `![shot](${screenshot})`, timestamp: "2026-11-16T01:00:30.000Z" });
    writeFileSync(screenshot, "third picture, written after both messages");

    // Provider history carries the original paths and the provider's own timestamps.
    snapshotter.beginReplay("agent-1");
    const replayedFirst = emit({
      text: `![shot](${screenshot})`,
      mode: "history",
      timestamp: "2026-11-16T01:00:02.000Z",
    });
    const replayedSecond = emit({
      text: `![shot](${screenshot})`,
      mode: "history",
      timestamp: "2026-11-16T01:00:31.000Z",
    });
    expect(readFileSync(imagePathOf(replayedFirst), "utf8")).toBe("first picture");
    expect(readFileSync(imagePathOf(replayedSecond), "utf8")).toBe("second picture");

    // Without timestamps the replay takes the snapshots in emission order.
    snapshotter.beginReplay("agent-1");
    const untimedFirst = emit({ text: `![shot](${screenshot})`, mode: "history" });
    const untimedSecond = emit({ text: `![shot](${screenshot})`, mode: "history" });
    expect(readFileSync(imagePathOf(untimedFirst), "utf8")).toBe("first picture");
    expect(readFileSync(imagePathOf(untimedSecond), "utf8")).toBe("second picture");
  });

  test("history survives a new store instance (daemon restart)", () => {
    const screenshot = path.join(workDir, "shot.png");
    writeFileSync(screenshot, "original");
    emit({ text: `![shot](${screenshot})` });
    writeFileSync(screenshot, "replaced");

    const restarted = new AssistantImageSnapshotter(
      new AssistantImageSnapshotStore({ rootDir: store.rootDir, maxImageBytes: 64 }),
    );
    const replayed = restarted.rewriteItem({
      agentId: "agent-1",
      cwd: workDir,
      item: assistant(`![shot](${screenshot})`),
      mode: "history",
    });
    expect(readFileSync(imagePathOf(replayed), "utf8")).toBe("original");
  });

  test("history of a message emitted before snapshots existed keeps the live path", () => {
    const screenshot = path.join(workDir, "old.png");
    writeFileSync(screenshot, "live");
    const text = `![old](${screenshot})`;
    expect(textOf(emit({ text, mode: "history" }))).toBe(text);
  });

  test("deleting an agent removes its snapshots unless another agent shows the same bytes", () => {
    const shared = path.join(workDir, "shared.png");
    const own = path.join(workDir, "own.png");
    writeFileSync(shared, "same bytes");
    writeFileSync(own, "only agent one");
    const sharedFromOne = imagePathOf(emit({ agentId: "agent-1", text: `![s](${shared})` }));
    const ownFromOne = imagePathOf(emit({ agentId: "agent-1", text: `![o](${own})` }));
    const sharedFromTwo = imagePathOf(emit({ agentId: "agent-2", text: `![s](${shared})` }));
    expect(sharedFromTwo).toBe(sharedFromOne);

    snapshotter.deleteAgent("agent-1");

    expect(existsSync(ownFromOne)).toBe(false);
    expect(readFileSync(sharedFromTwo, "utf8")).toBe("same bytes");

    snapshotter.deleteAgent("agent-2");
    expect(existsSync(sharedFromTwo)).toBe(false);
  });

  test("an agent quoting an existing snapshot keeps it alive after the first agent is deleted", () => {
    const source = path.join(workDir, "a.png");
    writeFileSync(source, "bytes");
    const snapshotPath = imagePathOf(emit({ agentId: "agent-1", text: `![a](${source})` }));
    const quoted = emit({ agentId: "agent-2", text: `![a](${snapshotPath})` });
    expect(imagePathOf(quoted)).toBe(snapshotPath);

    snapshotter.deleteAgent("agent-1");
    expect(existsSync(snapshotPath)).toBe(true);
  });

  test("keeps the live path above the size cap, outside readable roots, and for non-images", () => {
    const large = path.join(workDir, "large.png");
    writeFileSync(large, Buffer.alloc(65));
    const notImage = path.join(workDir, "notes.txt");
    writeFileSync(notImage, "text");
    const outside = "/usr/share/paseo-test-does-not-exist.png";

    for (const source of [large, notImage, outside, "https://example.com/a.png"]) {
      const text = `![x](${source})`;
      expect(textOf(emit({ text }))).toBe(text);
    }
  });

  test("an unreferenced blob left by a stopped daemon is swept", () => {
    const source = path.join(workDir, "a.png");
    writeFileSync(source, "kept");
    const kept = imagePathOf(emit({ text: `![a](${source})` }));
    const orphan = path.join(store.blobDir, `${"0".repeat(64)}.png`);
    writeFileSync(orphan, "orphan");

    expect(store.sweepUnreferencedBlobs()).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });
});
