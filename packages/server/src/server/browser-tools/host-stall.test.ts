import { describe, expect, test } from "vitest";
import type { PushPayload } from "../push/index.js";
import { BrowserHostStallPushNotifier, createMacSecurityPromptProbe } from "./host-stall.js";

describe("createMacSecurityPromptProbe", () => {
  test("asks once per cache window and never off macOS", async () => {
    let clock = 0;
    let runs = 0;
    const probe = createMacSecurityPromptProbe({
      platform: "darwin",
      now: () => clock,
      cacheMs: 3_000,
      isRunning: async () => {
        runs += 1;
        return true;
      },
    });
    expect(await probe()).toBe(true);
    clock = 2_999;
    expect(await probe()).toBe(true);
    expect(runs).toBe(1);
    clock = 3_000;
    await probe();
    expect(runs).toBe(2);

    const linux = createMacSecurityPromptProbe({
      platform: "linux",
      isRunning: async () => {
        throw new Error("must not run");
      },
    });
    expect(await linux()).toBe(false);
  });

  test("a failing check reads as no prompt", async () => {
    const probe = createMacSecurityPromptProbe({
      platform: "darwin",
      isRunning: async () => {
        throw new Error("pgrep missing");
      },
    });
    expect(await probe()).toBe(false);
  });
});

describe("BrowserHostStallPushNotifier", () => {
  function notifier() {
    let clock = 0;
    const sent: PushPayload[] = [];
    const subject = new BrowserHostStallPushNotifier({
      serverId: "srv-1",
      now: () => clock,
      send: async (payload) => {
        sent.push(payload);
      },
    });
    return {
      subject,
      sent,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test("sends one Korean push per stall episode", () => {
    const { subject, sent, advance } = notifier();
    subject.stalled({ securityPrompt: true });
    advance(60_000);
    subject.stalled({ securityPrompt: true });
    subject.stalled({ securityPrompt: false });
    expect(sent).toEqual([
      {
        title: "Daseo",
        body: "Mac의 Daseo가 macOS 확인 창 때문에 멈췄습니다. Mac에서 창을 확인해 주세요.",
        data: { serverId: "srv-1" },
      },
    ]);
  });

  test("a recovery between stalls starts a new episode", () => {
    const { subject, sent, advance } = notifier();
    subject.stalled({ securityPrompt: true });
    advance(1_000);
    subject.answered();
    subject.stalled({ securityPrompt: false });
    expect(sent.map((payload) => payload.body)).toEqual([
      "Mac의 Daseo가 macOS 확인 창 때문에 멈췄습니다. Mac에서 창을 확인해 주세요.",
      "Mac의 Daseo 앱이 응답하지 않아 브라우저 도구가 멈췄습니다. Mac 화면을 확인해 주세요.",
    ]);
  });

  test("a stall that never ends repeats only after 30 minutes", () => {
    const { subject, sent, advance } = notifier();
    subject.stalled({ securityPrompt: true });
    advance(30 * 60_000 - 1);
    subject.stalled({ securityPrompt: true });
    expect(sent).toHaveLength(1);
    advance(1);
    subject.stalled({ securityPrompt: true });
    expect(sent).toHaveLength(2);
  });
});
