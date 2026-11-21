import { describe, expect, it } from "vitest";
import { formatReturnSyncTrace, shortTraceId } from "./return-sync-trace";

describe("return sync trace (Daseo delta 140)", () => {
  it("writes one greppable line, skipping unset fields and marking empty ones", () => {
    expect(
      formatReturnSyncTrace("catch-up-finish", {
        agent: shortTraceId("5975d8d7-7ed7-44a2-8233-41f974f8ebd5"),
        outcome: "complete",
        pageEndSeq: 80,
        storeEndSeq: null,
        skipped: undefined,
        drawnIsNewest: false,
      }),
    ).toBe(
      "[return-sync] catch-up-finish agent=5975d8d7 outcome=complete pageEndSeq=80 storeEndSeq=- drawnIsNewest=false",
    );
  });
});
