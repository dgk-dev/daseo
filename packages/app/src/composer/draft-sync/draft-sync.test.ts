import { describe, expect, it } from "vitest";
import { ComposerDraftRequestError } from "@getpaseo/client/internal/daemon-client";
import type { ComposerDraft, ComposerDraftAttachment } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata, HostUploadReference } from "@/attachments/types";
import type { DraftInput } from "@/stores/draft-store/state";
import type { ComposerActivitySource } from "./composer-activity";
import {
  ComposerDraftSync,
  DRAFT_PUSH_DEBOUNCE_MS,
  type ComposerDraftSyncClient,
} from "./draft-sync";

// Daseo delta 139. A fake daemon with the real store semantics (rising revision, conditional
// clear, push to every subscriber), a manual clock for timers, and a scripted composer activity.

const KEY = "agent:srv:a1";

class FakeDaemon {
  draft: ComposerDraft | null = null;
  now = 1_000;
  readonly listeners = new Set<(draft: ComposerDraft) => void>();
  readonly writes: Array<{ text: string; clientId: string }> = [];
  readonly uploads: string[] = [];
  readonly lists: Array<Record<string, number> | undefined> = [];
  agentExists = true;

  store(input: { text: string; attachments: ComposerDraftAttachment[]; clientId: string }) {
    this.draft = {
      agentId: "a1",
      text: input.text,
      attachments: input.attachments,
      revision: (this.draft?.revision ?? 0) + 1,
      updatedAt: this.now,
      clientId: input.clientId,
    };
    for (const listener of this.listeners) listener(this.draft);
    return this.draft;
  }

  client(): ComposerDraftSyncClient {
    const client = {
      listComposerDrafts: async (options: { knownRevisions?: Record<string, number> } = {}) => {
        this.lists.push(options.knownRevisions);
        const known = options.knownRevisions ?? {};
        return this.draft && known[this.draft.agentId] !== this.draft.revision ? [this.draft] : [];
      },
      setComposerDraft: async (input: {
        text: string;
        attachments: ComposerDraftAttachment[];
        clientId: string;
      }) => {
        this.writes.push({ text: input.text, clientId: input.clientId });
        if (!this.agentExists) {
          throw new ComposerDraftRequestError("Agent a1 does not exist.", "agent_not_found");
        }
        return this.store(input);
      },
      clearComposerDraft: async (input: { clientId: string; revision: number }) => {
        this.writes.push({ text: "<clear>", clientId: input.clientId });
        if (!this.agentExists) {
          throw new ComposerDraftRequestError("Agent a1 does not exist.", "agent_not_found");
        }
        if (!this.draft) return { draft: null, cleared: true };
        if (this.draft.revision > input.revision) return { draft: this.draft, cleared: false };
        const cleared = this.store({ text: "", attachments: [], clientId: input.clientId });
        return { draft: cleared, cleared: true };
      },
      on: (_type: string, handler: (message: { payload: { draft: ComposerDraft } }) => void) => {
        const listener = (draft: ComposerDraft) => handler({ payload: { draft } });
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      uploadFile: async () => {
        throw new Error("not used");
      },
    };
    return client as unknown as ComposerDraftSyncClient;
  }
}

class Timers {
  now = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  set = (callback: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  };

  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

class FakeActivity implements ComposerActivitySource {
  busy = false;
  editIdleInMs: number | null = null;
  private readonly listeners = new Set<(draftKey: string | null) => void>();

  isBusy(): boolean {
    return this.busy;
  }

  msUntilEditIdle(): number | null {
    return this.editIdleInMs;
  }

  onMaybeIdle(listener: (draftKey: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  release(draftKey: string | null): void {
    this.busy = false;
    this.editIdleInMs = null;
    for (const listener of this.listeners) listener(draftKey);
  }
}

function image(id: string, hostUpload?: HostUploadReference): DraftInput["attachments"][number] {
  const metadata: AttachmentMetadata = {
    id,
    mimeType: "image/png",
    storageType: "native-file",
    storageKey: `/cache/${id}.png`,
    fileName: `${id}.png`,
    byteSize: 10,
    createdAt: 1,
    ...(hostUpload ? { hostUpload } : {}),
  };
  return { kind: "image", metadata };
}

function createDevice(options: {
  daemon: FakeDaemon;
  clientId: string;
  timers: Timers;
  activity?: FakeActivity;
  uploadImage?: (attachment: AttachmentMetadata) => Promise<HostUploadReference>;
  local?: { draft: DraftInput | undefined; updatedAt: number };
}) {
  let local = options.local ?? { draft: undefined as DraftInput | undefined, updatedAt: 0 };
  const listeners = new Set<(keys: string[]) => void>();
  const applied: DraftInput[] = [];
  const activity = options.activity ?? new FakeActivity();
  const setLocal = (draft: DraftInput | undefined) => {
    local = { draft, updatedAt: options.timers.now + options.daemon.now };
    for (const listener of listeners) listener([KEY]);
  };
  const sync = new ComposerDraftSync({
    clientId: options.clientId,
    readLocal: () => local,
    listLocalKeys: () => (local.draft || local.updatedAt > 0 ? [KEY] : []),
    applyRemote: (_key, draft) => {
      applied.push(draft);
      setLocal(draft.text || draft.attachments.length > 0 ? draft : undefined);
    },
    attachHostUpload: (_key, attachmentId, upload) => {
      if (!local.draft) return;
      setLocal({
        ...local.draft,
        attachments: local.draft.attachments.map((attachment) =>
          attachment.kind === "image" && attachment.metadata.id === attachmentId
            ? { kind: "image", metadata: { ...attachment.metadata, hostUpload: upload } }
            : attachment,
        ),
      });
    },
    subscribeLocal: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    whenLocalReady: async () => undefined,
    activity,
    registerThumbnailSource: () => () => undefined,
    uploadImage: async (_client, attachment) =>
      options.uploadImage ? options.uploadImage(attachment) : Promise.reject(new Error("offline")),
    setTimer: options.timers.set,
    clearTimer: options.timers.clear,
    warn: () => undefined,
  });
  return {
    sync,
    activity,
    applied,
    type: (text: string) =>
      setLocal(text ? { text, attachments: local.draft?.attachments ?? [] } : undefined),
    setLocal,
    get local() {
      return local.draft;
    },
    attach: () => sync.attach("srv", options.daemon.client()),
  };
}

describe("ComposerDraftSync", () => {
  it("sends local edits after the debounce and the other device applies them", async () => {
    const daemon = new FakeDaemon();
    const timers = new Timers();
    const mac = createDevice({ daemon, clientId: "mac", timers });
    const phone = createDevice({ daemon, clientId: "phone", timers });
    await mac.attach();
    await phone.attach();

    phone.type("안");
    phone.type("안녕");
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS - 1);
    expect(daemon.writes).toEqual([]);
    await timers.advance(1);

    expect(daemon.writes).toEqual([{ text: "안녕", clientId: "phone" }]);
    expect(mac.local?.text).toBe("안녕");
    // The writer ignores its own echo.
    expect(phone.applied).toEqual([]);
  });

  it.each([
    ["IME composition", (activity: FakeActivity) => activity.release(null)],
    ["dictation", (activity: FakeActivity) => activity.release(KEY)],
  ])("holds a remote draft during %s and applies it when that ends", async (_label, end) => {
    const daemon = new FakeDaemon();
    const timers = new Timers();
    const mac = createDevice({ daemon, clientId: "mac", timers });
    await mac.attach();
    mac.activity.busy = true;

    daemon.store({ text: "from phone", attachments: [], clientId: "phone" });
    await flush();
    expect(mac.applied).toEqual([]);

    end(mac.activity);
    await flush();
    expect(mac.local?.text).toBe("from phone");
  });

  it("holds a remote draft for 2 s after local typing, then applies it if still newer", async () => {
    const daemon = new FakeDaemon();
    const timers = new Timers();
    const mac = createDevice({ daemon, clientId: "mac", timers });
    await mac.attach();
    mac.activity.busy = true;
    mac.activity.editIdleInMs = 2000;

    daemon.store({ text: "from phone", attachments: [], clientId: "phone" });
    await flush();
    await timers.advance(1999);
    expect(mac.applied).toEqual([]);

    mac.activity.busy = false;
    await timers.advance(10);
    expect(mac.local?.text).toBe("from phone");
  });

  it("drops a held remote draft when the local text typed meanwhile was stored after it", async () => {
    const daemon = new FakeDaemon();
    const timers = new Timers();
    const mac = createDevice({ daemon, clientId: "mac", timers });
    await mac.attach();
    mac.activity.busy = true;

    daemon.store({ text: "from phone", attachments: [], clientId: "phone" });
    mac.type("typed on the mac");
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
    mac.activity.release(KEY);
    await flush();

    expect(mac.applied).toEqual([]);
    expect(mac.local?.text).toBe("typed on the mac");
    expect(daemon.draft?.text).toBe("typed on the mac");
  });

  it("applies a remote draft at once when the composer is not in use", async () => {
    const daemon = new FakeDaemon();
    const timers = new Timers();
    const mac = createDevice({ daemon, clientId: "mac", timers });
    await mac.attach();

    daemon.store({ text: "now", attachments: [], clientId: "phone" });
    await flush();

    expect(mac.applied).toEqual([{ text: "now", attachments: [] }]);
  });

  it("an emptied draft clears only what this device saw; text written since comes back", async () => {
    const daemon = new FakeDaemon();
    const timers = new Timers();
    const mac = createDevice({ daemon, clientId: "mac", timers });
    await mac.attach();
    mac.type("send me");
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
    expect(daemon.draft).toMatchObject({ text: "send me", revision: 1 });

    // The Mac sends (the composer empties); the phone writes before the clear reaches the host.
    mac.type("");
    daemon.store({ text: "phone, during the send", attachments: [], clientId: "phone" });
    mac.activity.busy = true; // the Mac's echo of the phone write is held, as while typing
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
    expect(daemon.draft?.text).toBe("phone, during the send");
    mac.activity.release(KEY);
    await flush();
    expect(mac.local?.text).toBe("phone, during the send");

    // A plain send clears for both.
    mac.type("");
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
    expect(daemon.draft).toMatchObject({ text: "", clientId: "mac" });
  });

  it("uploads an attached image once, then syncs its reference", async () => {
    const daemon = new FakeDaemon();
    const timers = new Timers();
    const uploaded: string[] = [];
    const phone = createDevice({
      daemon,
      clientId: "phone",
      timers,
      uploadImage: async (attachment) => {
        uploaded.push(attachment.id);
        return {
          uploadId: `upload_${attachment.id}`,
          mimeType: "image/jpeg",
          thumbnail: { mimeType: "image/jpeg", width: 4, height: 3 },
        };
      },
    });
    const mac = createDevice({ daemon, clientId: "mac", timers });
    await phone.attach();
    await mac.attach();

    phone.setLocal({ text: "look", attachments: [image("img1")] });
    await flush();
    phone.type("look!");
    // The text goes first; the image uploads once the host has accepted this chat.
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
    expect(uploaded).toEqual(["img1"]);
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);

    expect(uploaded).toEqual(["img1"]);
    expect(daemon.draft?.attachments).toEqual([
      {
        id: "img1",
        kind: "image",
        uploadId: "upload_img1",
        fileName: "img1.png",
        mimeType: "image/jpeg",
        size: 10,
        thumbnail: { mimeType: "image/jpeg", width: 4, height: 3 },
      },
    ]);
    const macImage = mac.local?.attachments[0];
    expect(macImage?.kind === "image" && macImage.metadata).toMatchObject({
      storageType: "host-upload",
      storageKey: "upload_img1",
      hostUpload: { uploadId: "upload_img1", serverId: "srv" },
    });
    // A text-only change afterwards carries the same image reference and no image bytes.
    phone.type("look!!");
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
    expect(uploaded).toEqual(["img1"]);
    expect(JSON.stringify(daemon.draft)).not.toContain("AAAA");
  });

  it("stops syncing a chat the host refused as deleted, and uploads none of its images", async () => {
    const daemon = new FakeDaemon();
    daemon.agentExists = false;
    const timers = new Timers();
    const uploaded: string[] = [];
    const phone = createDevice({
      daemon,
      clientId: "phone",
      timers,
      local: { draft: { text: "old draft", attachments: [image("img1")] }, updatedAt: 1 },
      uploadImage: async (attachment) => {
        uploaded.push(attachment.id);
        return { uploadId: `upload_${attachment.id}`, mimeType: "image/jpeg", thumbnail: null };
      },
    });
    await phone.attach();
    await timers.advance(0);
    expect(daemon.writes).toEqual([{ text: "old draft", clientId: "phone" }]);

    phone.type("more");
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
    await phone.attach(); // app foreground
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);

    expect(daemon.writes).toHaveLength(1);
    expect(uploaded).toEqual([]);
  });

  it("keeps an image whose upload failed on this device when another device's draft arrives", async () => {
    const daemon = new FakeDaemon();
    const timers = new Timers();
    const phone = createDevice({ daemon, clientId: "phone", timers });
    await phone.attach();
    phone.setLocal({ text: "", attachments: [image("local")] });
    await flush();

    daemon.store({ text: "from mac", attachments: [], clientId: "mac" });
    await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);

    expect(phone.local?.text).toBe("from mac");
    expect(phone.local?.attachments.map((a) => a.kind === "image" && a.metadata.id)).toEqual([
      "local",
    ]);
  });

  describe("reconnect", () => {
    it("names the revisions it holds, so a reconnect with nothing changed moves no draft", async () => {
      const daemon = new FakeDaemon();
      const timers = new Timers();
      const mac = createDevice({ daemon, clientId: "mac", timers });
      await mac.attach();
      daemon.store({ text: "from phone", attachments: [], clientId: "phone" });
      await flush();
      expect(mac.local?.text).toBe("from phone");

      await mac.attach();
      await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);

      expect(daemon.lists).toEqual([{}, { a1: 1 }]);
      expect(daemon.writes).toEqual([]);
      expect(mac.applied).toHaveLength(1);
    });

    it("sends a change made while the host still held this device's revision", async () => {
      const daemon = new FakeDaemon();
      const timers = new Timers();
      const mac = createDevice({ daemon, clientId: "mac", timers });
      await mac.attach();
      mac.type("before");
      await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
      mac.sync.detach("srv");
      mac.type("typed offline");
      await mac.attach();
      await timers.advance(0);
      expect(daemon.draft?.text).toBe("typed offline");
    });

    it("uploads a local draft written while offline after the host's", async () => {
      const daemon = new FakeDaemon();
      daemon.store({ text: "old", attachments: [], clientId: "phone" });
      const timers = new Timers();
      const mac = createDevice({
        daemon,
        clientId: "mac",
        timers,
        local: { draft: { text: "written offline", attachments: [] }, updatedAt: daemon.now + 5 },
      });
      await mac.attach();
      await timers.advance(0);
      expect(daemon.draft?.text).toBe("written offline");
      expect(mac.applied).toEqual([]);
    });

    it("applies the host's draft when it is newer than the local one", async () => {
      const daemon = new FakeDaemon();
      daemon.now = 5_000;
      daemon.store({ text: "newer on the host", attachments: [], clientId: "phone" });
      const timers = new Timers();
      const mac = createDevice({
        daemon,
        clientId: "mac",
        timers,
        local: { draft: { text: "stale", attachments: [] }, updatedAt: 4_000 },
      });
      await mac.attach();
      expect(mac.local?.text).toBe("newer on the host");
      expect(daemon.writes).toEqual([]);
    });

    it("adopts the host revision when the content is the same", async () => {
      const daemon = new FakeDaemon();
      daemon.store({ text: "same", attachments: [], clientId: "mac" });
      const timers = new Timers();
      const mac = createDevice({
        daemon,
        clientId: "mac",
        timers,
        local: { draft: { text: "same", attachments: [] }, updatedAt: 1 },
      });
      await mac.attach();
      await timers.advance(DRAFT_PUSH_DEBOUNCE_MS);
      expect(daemon.writes).toEqual([]);
      expect(mac.applied).toEqual([]);
    });
  });
});
