import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AssistantImageSnapshotIndexStorage } from "./snapshot-cache";

const INDEX_STORAGE_KEY = "paseo.assistant-image-snapshots.v1";

export const asyncStorageSnapshotIndex: AssistantImageSnapshotIndexStorage = {
  async load() {
    return await AsyncStorage.getItem(INDEX_STORAGE_KEY);
  },
  async save(value) {
    await AsyncStorage.setItem(INDEX_STORAGE_KEY, value);
  },
};
