import path from "node:path";

export interface DialogDirectoryMemory {
  defaultPath(requested: string | undefined): string | undefined;
  remember(selectedPaths: readonly string[]): void;
}

// Since Electron 43 an open dialog without `defaultPath` starts in Downloads instead of the
// folder the user last picked from (macOS NSOpenPanel's own memory). Remembering the folder
// of the last selection keeps the picker opening where the user left it.
export function createDialogDirectoryMemory(): DialogDirectoryMemory {
  let lastDirectory: string | undefined;
  return {
    defaultPath(requested) {
      return requested ?? lastDirectory;
    },
    remember(selectedPaths) {
      const first = selectedPaths[0];
      if (first && path.isAbsolute(first)) {
        lastDirectory = path.dirname(first);
      }
    },
  };
}
