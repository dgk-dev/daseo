import type { BackgroundSuspendTarget } from "./controller";

// Daseo delta 86: web and Electron keep their connections; see index.native.ts.
export function startBackgroundSuspend(_target: BackgroundSuspendTarget): () => void {
  return () => {};
}

export function holdDaemonConnection(): () => void {
  return () => {};
}
