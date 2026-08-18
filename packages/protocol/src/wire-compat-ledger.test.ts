import { describe, expect, test } from "vitest";
import {
  checkWireLedger,
  computeWireSurface,
  digestTypeScriptDeclaration,
  readWireLedger,
} from "../scripts/wire-surface-digest.mjs";

describe("wire compatibility ledger", () => {
  test("covers the current released protocol surface", () => {
    expect(checkWireLedger(readWireLedger(), computeWireSurface())).toEqual([]);
  });

  test("ignores formatting and comments but catches payload shape drift", () => {
    const baseline = digestTypeScriptDeclaration(
      "export interface Frame { id: string; payload?: Uint8Array; }",
      "Frame",
    );
    const reformatted = digestTypeScriptDeclaration(
      "// wire docs\nexport interface Frame {\n  id: string; /* optional payload */ payload?: Uint8Array;\n}",
      "Frame",
    );
    const narrowed = digestTypeScriptDeclaration(
      "export interface Frame { id: string; payload: Uint8Array; }",
      "Frame",
    );

    expect(reformatted).toBe(baseline);
    expect(narrowed).not.toBe(baseline);
  });

  test("rejects a digest change without a digest-scoped rationale", () => {
    const current = computeWireSurface();
    const ledger = structuredClone(readWireLedger());
    const root = Object.keys(current)[0];
    ledger.roots[root].digest = "sha256:released-shape";
    ledger.compatibleChanges = ledger.compatibleChanges.filter(
      (change: { root: string }) => change.root !== root,
    );

    expect(checkWireLedger(ledger, current)).toEqual([
      `${root} changed to ${current[root].digest} (${current[root].declarationCount} declarations) without a digest-scoped compatibility rationale`,
    ]);
  });
});
