/**
 * Rollback for Daseo delta 146 (timeline compaction): expands every compacted
 * timeline (`timelines/<agent>/rows.jsonl`) back into one file per row, so a
 * daemon older than delta 146 sees every row again. Run it before starting an
 * older daemon on a home that was compacted.
 *
 *   npx tsx scripts/expand-timelines.ts [--home <PASEO_HOME>] [--agent <id>]... [--dry-run] [--force]
 *
 * --home     defaults to $PASEO_HOME, then ~/.paseo
 * --agent    expands only these agents (repeatable); default is every compacted agent
 * --dry-run  lists what would be written and changes nothing
 * --force    runs even though a daemon appears to be running on that home
 *
 * It refuses to run while that home's daemon is alive (a live pid in paseo.pid,
 * or anything answering on the listen address the home's config resolves to):
 * the daemon may compact or write the same agents meanwhile. Exit code 1 when
 * any agent failed; failed agents are left exactly as they were.
 */
import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseListenString } from "../src/server/bootstrap.js";
import { loadConfig } from "../src/server/config.js";
import { FileBackedAgentTimelineStore } from "../src/server/agent/file-backed-agent-timeline-store.js";
import {
  listTimelineDirectory,
  readBundleLines,
  TIMELINE_BUNDLE_FILE,
} from "../src/server/agent/timeline-row-files.js";
import { isLocked } from "../src/server/pid-lock.js";
import { resolvePaseoHome } from "../src/server/paseo-home.js";

const PROBE_TIMEOUT_MS = 1_000;

function probe(options: net.NetConnectOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(options);
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Why a daemon looks alive on this home, or null. */
async function runningDaemon(paseoHome: string): Promise<string | null> {
  const lock = await isLocked(paseoHome);
  if (lock.locked && lock.info) {
    return `paseo.pid names running PID ${lock.info.pid} (listen ${lock.info.listen ?? "unknown"})`;
  }
  const listen = loadConfig(paseoHome).listen;
  const target = parseListenString(listen);
  const listening =
    target.type === "tcp"
      ? await probe({ host: target.host, port: target.port })
      : await probe({ path: target.path });
  return listening ? `something is listening on ${listen}` : null;
}

/** Bundled rows that have no loose file yet: the files an expansion would write. */
async function countMissingLooseRows(directory: string): Promise<number> {
  const loose = new Set((await listTimelineDirectory(directory)).looseSeqs);
  let missing = 0;
  for await (const line of readBundleLines(directory)) {
    if (!loose.has(line.seq)) missing += 1;
  }
  return missing;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      agent: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  const paseoHome = values.home
    ? resolvePaseoHome({ PASEO_HOME: values.home })
    : resolvePaseoHome();
  const timelinesDir = path.join(paseoHome, "timelines");
  if (!existsSync(timelinesDir)) {
    console.log(`No timelines directory under ${paseoHome}; nothing to expand.`);
    return 0;
  }

  const daemon = await runningDaemon(paseoHome);
  if (daemon && !values.force) {
    console.error(`Refusing to run: ${daemon}. Stop the daemon first, or pass --force.`);
    return 2;
  }
  if (daemon) console.warn(`--force: running although ${daemon}.`);

  const agents = (values.agent ?? readdirSync(timelinesDir)).filter((agentId) =>
    existsSync(path.join(timelinesDir, agentId, TIMELINE_BUNDLE_FILE)),
  );
  const dryRun = values["dry-run"];
  const store = new FileBackedAgentTimelineStore(timelinesDir);
  let expanded = 0;
  let filesWritten = 0;
  let failed = 0;
  for (const agentId of agents) {
    try {
      if (dryRun) {
        const missing = await countMissingLooseRows(path.join(timelinesDir, agentId));
        filesWritten += missing;
        expanded += 1;
        console.log(`would expand ${agentId}: ${missing} loose files to write`);
        continue;
      }
      const result = await store.expandTimeline(agentId);
      if (result.status === "expanded") {
        expanded += 1;
        filesWritten += result.looseFilesWritten;
      }
    } catch (error) {
      failed += 1;
      console.error(`FAILED ${agentId}: ${(error as Error).message}`);
    }
  }
  console.log(
    `${dryRun ? "Dry run: would expand" : "Expanded"} ${expanded} of ${agents.length} compacted agents, ` +
      `${filesWritten} loose files ${dryRun ? "to write" : "written"}, ${failed} failed (home ${paseoHome}).`,
  );
  return failed > 0 ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
