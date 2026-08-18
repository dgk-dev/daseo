import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import surface from "./app-server-upstream-surface.json" with { type: "json" };

const agentSource = readFileSync(
  fileURLToPath(new URL("../codex-app-server-agent.ts", import.meta.url)),
  "utf8",
);

function captureLiterals(pattern: RegExp): string[] {
  return [...agentSource.matchAll(pattern)].map((match) => match[1]).sort();
}

describe("Codex app-server upstream parity", () => {
  test("pins the authoritative upstream source", () => {
    expect(surface).toMatchObject({
      upstream: "openai/codex",
      commit: "a04940cb12cca43510aaf8d601ce42352f0902cb",
      source: "codex-rs/app-server-protocol/src/protocol/common.rs",
      sourceSha256: "32e0aea71cc88a9a62bb5c824b19993bad9629ebecd6a19f55745bad3f7a3b47",
    });
  });

  test("every outbound request and notification exists upstream or is explicitly legacy", () => {
    const requests = captureLiterals(/\.request\(\s*["']([^"']+)/g);
    const notifications = captureLiterals(/\.notify\(\s*["']([^"']+)/g);
    const supportedRequests = new Set([...surface.clientRequests, ...surface.legacyClientRequests]);

    expect(requests.filter((method) => !supportedRequests.has(method))).toEqual([]);
    expect(notifications.filter((method) => !surface.clientNotifications.includes(method))).toEqual(
      [],
    );
  });

  test("every parsed inbound method exists upstream or is explicitly legacy", () => {
    const parsedMethods = captureLiterals(/method:\s*z\.literal\(["']([^"']+)/g);
    const supportedInbound = new Set([
      ...surface.serverRequests,
      ...surface.serverNotifications,
      ...surface.legacyServerNotifications,
    ]);

    expect(parsedMethods.filter((method) => !supportedInbound.has(method))).toEqual([]);
  });
});
