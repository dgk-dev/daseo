import { mkdirSync } from "node:fs";
import path from "node:path";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { openGlobalNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

/**
 * The chat column of the running-rail change: the subagents track reads like `docker compose`,
 * an empty chat shows the login banner over a bottom-left prompt line, and finished command
 * rows end in their exit code and duration.
 *
 * Set RUNNING_RAIL_SHOTS_DIR to also save screenshots of each state at both sizes.
 */
const SHOTS_DIR = process.env.RUNNING_RAIL_SHOTS_DIR;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, name) });
}

test.describe("Running rail: chat column", () => {
  let workspace: SeededWorkspace;

  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    workspace = await seedWorkspace({ repoPrefix: "lane-a-running-rail-" });
  });

  test.afterAll(async () => {
    await workspace?.cleanup();
  });

  async function createChild(parentId: string, title: string, prompt: string, model: string) {
    return workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title,
      modeId: "load-test",
      model,
      initialPrompt: prompt,
      labels: { [PARENT_AGENT_ID_LABEL]: parentId },
    });
  }

  test("subagents track shows Running N/M, then state words and times per row", async ({
    page,
  }) => {
    const parent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Track parent",
      modeId: "load-test",
      model: "ten-second-stream",
    });
    const running = await createChild(
      parent.id,
      "research worker: daseo-task-sidebar",
      "stay running",
      "thirty-minute-stream",
    );
    const done = await createChild(
      parent.id,
      "research worker: daseo-nerd-chrome",
      "emit 2 agent stream updates",
      "ten-second-stream",
    );
    const failed = await createChild(
      parent.id,
      "implementer: panel width",
      "emit a synthetic turn failure",
      "ten-second-stream",
    );
    await workspace.client.waitForAgentUpsert(running.id, (agent) => agent.status === "running");
    await workspace.client.waitForAgentUpsert(done.id, (agent) => agent.status === "idle");
    await workspace.client.waitForAgentUpsert(failed.id, (agent) => agent.status === "error");

    for (const [label, viewport] of [
      ["1440", DESKTOP],
      ["390", PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: parent.id });

      const header = page.getByTestId("subagents-track-header");
      await expect(header).toBeVisible({ timeout: 60_000 });
      // The parent has no message yet: the banner stands where the centred line used to.
      await expect(page.getByTestId("login-banner")).toContainText("Welcome to Daseo");
      await expect(header).toHaveAccessibleName("Running 1/3");
      // The braille spinner between the brackets; the elapsed time is on screen from the start.
      await expect(page.getByTestId("subagents-track-header-label")).toHaveText(
        /^\[[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\] Running 1\/3 {2}(\d+s|\d+min \d\ds)$/,
      );
      await shot(page, `A-track-collapsed-${label}.png`);

      await header.click();
      await expect(page.getByTestId(`subagents-track-state-${running.id}`)).toHaveText("Running");
      await expect(page.getByTestId(`subagents-track-state-${done.id}`)).toHaveText("Done");
      await expect(page.getByTestId(`subagents-track-state-${failed.id}`)).toHaveText("Error");
      const runningRow = page.getByTestId(`subagents-track-row-${running.id}`);
      await expect(runningRow.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
      await expect(page.getByTestId("subagents-track-glyph-done")).toHaveText("✔");
      await expect(page.getByTestId("subagents-track-glyph-error")).toHaveText("✘");
      // A working row counts up; a finished one shows a fixed total.
      const liveTime = page.getByTestId(`subagents-track-time-${running.id}`);
      const before = await liveTime.textContent();
      await expect(liveTime).not.toHaveText(before ?? "", { timeout: 5_000 });
      await expect(page.getByTestId(`subagents-track-time-${done.id}`)).toHaveText(
        /^(\d+s|\d+min \d\ds)$/,
      );
      await shot(page, `A-track-expanded-${label}.png`);
    }
  });

  test("an empty new session shows the login banner over a bottom-left prompt line", async ({
    page,
  }) => {
    for (const [label, viewport] of [
      ["1440", DESKTOP],
      ["390", PHONE],
    ] as const) {
      // The sidebar's New workspace button is off screen on a phone: open at desktop width.
      await page.setViewportSize(DESKTOP);
      await gotoAppShell(page);
      await openGlobalNewWorkspaceComposer(page);
      await page.setViewportSize(viewport);

      const banner = page.getByTestId("login-banner");
      await expect(banner).toContainText(/Welcome to Daseo \d+\.\d+\.\d+ \(\S+ \S+ \S+\)/);
      await expect(banner).toContainText(/Agents running:\s+\d+/);
      await expect(banner).toContainText(/Memory usage:\s+\d+% of \d+(\.\d)?GB/);
      await expect(banner).not.toContainText(/weekly|undefined|NaN/);

      const bannerBox = await banner.boundingBox();
      const input = page
        .getByRole("textbox", { name: "Message agent..." })
        .filter({ visible: true })
        .first();
      await expect(input).toBeVisible();
      const inputBox = await input.boundingBox();
      expect(bannerBox && inputBox).toBeTruthy();
      if (!bannerBox || !inputBox) return;
      // Banner at the top left, composer on the bottom line at the left inset: no centred column.
      expect(bannerBox.y).toBeLessThan(viewport.height * 0.25);
      expect(inputBox.y + inputBox.height).toBeGreaterThan(viewport.height * 0.75);
      if (viewport.width >= 1000) {
        const paneLeft = bannerBox.x;
        // The textbox follows the `folder$` prompt on the same line.
        expect(inputBox.x - paneLeft).toBeLessThan(320);
      }
      if (viewport.width >= 1000) {
        // One left inset: the banner text starts where the `folder$` prompt starts.
        const promptBox = await page
          .getByTestId("composer-shell-prompt")
          .filter({ visible: true })
          .first()
          .boundingBox();
        const titleBox = await page
          .getByText("New workspace", { exact: true })
          .last()
          .boundingBox();
        expect(titleBox?.x).toBe(bannerBox.x);
        expect(Math.abs((promptBox?.x ?? 0) - bannerBox.x)).toBeLessThanOrEqual(1);
      }
      await shot(page, `A-empty-session-banner-${label}.png`);
    }
  });

  test("finished command rows end in exit code and duration", async ({ page }) => {
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Exit codes",
      modeId: "load-test",
      model: "ten-second-stream",
    });
    await page.setViewportSize(DESKTOP);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible({
      timeout: 60_000,
    });
    // Sent while the page watches, so the rows are seen starting and ending.
    await workspace.client.sendAgentMessage(agent.id, "emit synthetic shell commands");

    const exits = page.getByTestId("tool-call-exit-code");
    await expect(exits).toHaveText(["exit 0", "exit 1"], { timeout: 30_000 });
    await expect(page.getByTestId("tool-call-duration")).toHaveText([/^\d+\.\ds$/, /^\d+\.\ds$/]);
    await shot(page, "A-tool-rows-exit-1440.png");

    await page.setViewportSize(PHONE);
    await expect(exits).toHaveText(["exit 0", "exit 1"]);
    await shot(page, "A-tool-rows-exit-390.png");
  });
});
