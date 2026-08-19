import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class DaseoActivationLaunchError extends Error {
  constructor(message) {
    super(message);
    this.name = "DaseoActivationLaunchError";
  }
}

export function launchDaseoActivationOnce({ scriptPath, spawnProcess = spawn }) {
  if (!path.isAbsolute(scriptPath)) {
    throw new DaseoActivationLaunchError("The Daseo activation script path must be absolute.");
  }
  if (!statSync(scriptPath).isFile()) {
    throw new DaseoActivationLaunchError(
      `The Daseo activation script is not a file: ${scriptPath}`,
    );
  }

  const child = spawnProcess("/bin/zsh", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) {
    throw new DaseoActivationLaunchError("The Daseo activation process did not start.");
  }
  child.unref();
  return child.pid;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [scriptPath] = process.argv.slice(2);
  if (!scriptPath) {
    throw new DaseoActivationLaunchError("Usage: daseo-activate-once.mjs <absolute-script-path>");
  }
  const pid = launchDaseoActivationOnce({ scriptPath });
  process.stdout.write(`Started one-shot Daseo activation as pid ${pid}.\n`);
}
