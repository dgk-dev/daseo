import { test, expect } from "../support/fixtures";
import { openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import {
  expectNoCollapsedComposerToolbarFrame,
  recordComposerToolbarFrames,
} from "../support/helpers/composer-control-density";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const SETTLE_MS = 1_000;

async function seedSettledMockAgent(workspace: SeededWorkspace, title: string) {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
  });
  await workspace.client.waitForAgentUpsert(
    agent.id,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  return { id: agent.id, title, cwd: workspace.repoPath, workspaceId: workspace.workspaceId };
}

function visibleAgentTab(page: import("@playwright/test").Page, agentId: string) {
  return page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
}

test.describe("Composer control density across tab switches", () => {
  test.describe.configure({ timeout: 180_000 });

  test("switching between agent tabs never paints a collapsed composer toolbar", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-density-agents-" });
    try {
      const first = await seedSettledMockAgent(workspace, "First chat");
      const second = await seedSettledMockAgent(workspace, "Second chat");
      await openWorkspaceWithAgents(page, [first, second]);

      await recordComposerToolbarFrames(page);
      await visibleAgentTab(page, first.id).click();
      await page.waitForTimeout(SETTLE_MS);
      await visibleAgentTab(page, second.id).click();
      await page.waitForTimeout(SETTLE_MS);

      await expectNoCollapsedComposerToolbarFrame(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("late input from an inactive agent tab cannot overwrite either session draft", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-session-isolation-" });
    try {
      const first = await seedSettledMockAgent(workspace, "First isolated chat");
      const second = await seedSettledMockAgent(workspace, "Second isolated chat");
      await openWorkspaceWithAgents(page, [first, second]);

      const visibleComposer = () =>
        page.locator("textarea[data-composer-input]").filter({ visible: true }).first();
      const firstDraft = `first draft ${Date.now()}`;
      const secondDraft = `second draft ${Date.now()}`;
      const lateForeignText = `late foreign input ${Date.now()}`;

      await visibleAgentTab(page, first.id).click();
      await visibleComposer().fill(firstDraft);
      const inactiveInput = await visibleComposer().elementHandle();
      if (!inactiveInput) throw new Error("Expected the first agent composer input");

      await visibleAgentTab(page, second.id).click();
      await visibleComposer().fill(secondDraft);

      // Model a delayed browser/IME input event that was queued for the old textarea before
      // the tab switch completed. Retained tabs keep that node mounted, but it no longer owns
      // physical or logical input and must not publish into its draft.
      await inactiveInput.evaluate((element, text) => {
        if (!(element instanceof HTMLTextAreaElement)) {
          throw new Error("Expected a retained HTML textarea");
        }
        // oxlint-disable-next-line typescript-eslint/unbound-method -- the native setter is rebound below
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (!setter) throw new Error("HTML textarea value setter is unavailable");
        setter.call(element, text);
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: text,
            inputType: "insertText",
          }),
        );
      }, lateForeignText);

      await expect(visibleComposer()).toHaveValue(secondDraft);
      await visibleAgentTab(page, first.id).click();
      await expect(visibleComposer()).toHaveValue(firstDraft);
      await visibleAgentTab(page, second.id).click();
      await expect(visibleComposer()).toHaveValue(secondDraft);
    } finally {
      await workspace.cleanup();
    }
  });

  test("delayed Enter from a retained inactive composer cannot submit its draft", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-submit-ownership-" });
    try {
      const first = await seedSettledMockAgent(workspace, "First submit owner");
      const second = await seedSettledMockAgent(workspace, "Second submit owner");
      await openWorkspaceWithAgents(page, [first, second]);

      const visibleComposer = () =>
        page.locator("textarea[data-composer-input]").filter({ visible: true }).first();
      const firstDraft = `inactive submit sentinel ${Date.now()}`;

      await visibleAgentTab(page, first.id).click();
      await visibleComposer().fill(firstDraft);
      const inactiveInput = await visibleComposer().elementHandle();
      if (!inactiveInput) throw new Error("Expected the first agent composer input");

      await visibleAgentTab(page, second.id).click();
      await inactiveInput.evaluate((element) => {
        for (const type of ["keydown", "keypress", "keyup"]) {
          element.dispatchEvent(
            new KeyboardEvent(type, {
              key: "Enter",
              code: "Enter",
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      });

      await expect(page.getByTestId("user-message").filter({ hasText: firstDraft })).toHaveCount(0);
      await visibleAgentTab(page, first.id).click();
      await expect(visibleComposer()).toHaveValue(firstDraft);
      await expect(page.getByTestId("user-message").filter({ hasText: firstDraft })).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("switching between draft tabs never paints a collapsed composer toolbar", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-density-drafts-" });
    try {
      await page.addInitScript(() => {
        localStorage.setItem(
          "@paseo:create-agent-preferences",
          JSON.stringify({
            provider: "mock",
            providerPreferences: { mock: { mode: "load-test" } },
          }),
        );
      });
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewChat(page);

      const draftTabs = page
        .locator('[data-testid^="workspace-tab-draft"]')
        .filter({ visible: true });
      await expect(draftTabs).toHaveCount(2, { timeout: 30_000 });
      await expect(
        page.locator('[data-testid="mode-control"]').filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 30_000 });

      await recordComposerToolbarFrames(page);
      await draftTabs.nth(0).click();
      await page.waitForTimeout(SETTLE_MS);
      await draftTabs.nth(1).click();
      await page.waitForTimeout(SETTLE_MS);

      await expectNoCollapsedComposerToolbarFrame(page);
    } finally {
      await workspace.cleanup();
    }
  });
});
