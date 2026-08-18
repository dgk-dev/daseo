#!/usr/bin/env node
import { checkWireLedger, computeWireSurface } from "./wire-surface-digest.mjs";

const current = computeWireSurface();
if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
  process.exit(0);
}

const failures = checkWireLedger(undefined, current);
if (failures.length > 0) {
  process.stderr.write(`Wire compatibility ledger failed:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`Wire compatibility ledger matches ${Object.keys(current).length} roots.\n`);
