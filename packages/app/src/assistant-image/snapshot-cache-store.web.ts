import {
  createAssistantImageSnapshotCache,
  type AssistantImageSnapshotBytesStore,
  type AssistantImageSnapshotCache,
} from "./snapshot-cache";
import { asyncStorageSnapshotIndex } from "./snapshot-cache-index-storage";

const DB_NAME = "paseo-assistant-image-snapshots";
const STORE_NAME = "snapshots";

interface StoredSnapshot {
  name: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error("IndexedDB is unavailable in this runtime."));
      return;
    }
    const request = idb.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "name" });
      }
    };
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to open the assistant image snapshot store.")),
    );
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function run<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return await new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    transaction.addEventListener("complete", () => resolve(request.result));
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Assistant image snapshot store request failed.")),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Assistant image snapshot store request aborted.")),
    );
  });
}

const indexedDbSnapshotBytes: AssistantImageSnapshotBytesStore = {
  async read(name) {
    const record = (await run("readonly", (store) => store.get(name))) as
      | StoredSnapshot
      | undefined;
    return record ? { kind: "blob", blob: record.blob } : null;
  },
  async write({ name, bytes, mimeType }) {
    // A copy is backed by a plain ArrayBuffer, which `Blob` requires.
    const record: StoredSnapshot = {
      name,
      blob: new Blob([new Uint8Array(bytes)], { type: mimeType }),
    };
    await run("readwrite", (store) => store.put(record));
  },
  async delete(name) {
    await run("readwrite", (store) => store.delete(name));
  },
};

let cache: AssistantImageSnapshotCache | null = null;

export function getAssistantImageSnapshotCache(): AssistantImageSnapshotCache {
  cache ??= createAssistantImageSnapshotCache({
    bytes: indexedDbSnapshotBytes,
    index: asyncStorageSnapshotIndex,
  });
  return cache;
}
