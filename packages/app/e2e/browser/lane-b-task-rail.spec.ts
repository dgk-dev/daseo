import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";

/**
 * The task rail (the right panel): 240 wide and docked on wide web layouts, a text meter in its
 * header, one-line rows that open in place, `no tasks` for a session without a list.
 *
 * Set TASK_RAIL_SHOTS_DIR to also save screenshots of each state.
 */
const SHOTS_DIR = process.env.TASK_RAIL_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, name) });
}

// The mock provider's stress turn emits one-item task lists; the last one is the session's list.
const ONE_TASK_PROMPT = "emit 2 agent stream updates";

interface FixtureTask {
  id: string;
  text: string;
  completed: boolean;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  state?: "hold" | "decision" | "deleted";
  note?: string;
}

const FIXTURE_TASKS: FixtureTask[] = [
  { id: "1", text: "Read the plan", completed: true, status: "completed" },
  { id: "2", text: "Rail widths and migration", completed: true, status: "completed" },
  { id: "3", text: "Docked by default on wide layouts", completed: true, status: "completed" },
  {
    id: "4",
    text: "Rail header meter and one-line rows that open in place",
    completed: false,
    status: "in_progress",
    activeForm: "Fixing the minimum width",
    note: "Rows keep the checkbox markers of delta 116.",
  },
  { id: "5", text: "Running display, option C", completed: false, status: "pending" },
  { id: "6", text: "Login banner on an empty session", completed: false, status: "pending" },
  { id: "7", text: "Exit code on finished tool rows", completed: false, status: "pending" },
  {
    id: "8",
    text: "Keep the rail open on the unfolded Fold",
    completed: false,
    status: "pending",
    state: "decision",
    note: "Waits for the owner: always open, or toggle as today.",
  },
  { id: "9", text: "Release notes", completed: false, status: "pending", state: "hold" },
  { id: "10", text: "Old idea", completed: false, status: "pending", state: "deleted" },
];

/**
 * Screenshot fixture: puts a list with every state into the app's session store through Metro's
 * dev module registry. The mock provider cannot emit task states, notes, or more than one task.
 * Returns false when the registry is not reachable (a production bundle).
 */
async function injectFixtureTasks(page: Page, agentId: string): Promise<boolean> {
  return page.evaluate(
    ({ serverId, targetAgentId, tasks }) => {
      interface MetroModule {
        verboseName?: string;
        isInitialized?: boolean;
        publicModule?: { exports?: Record<string, unknown> };
      }
      const metroRequire = (globalThis as { __r?: { getModules?: () => Map<number, MetroModule> } })
        .__r;
      const modules = metroRequire?.getModules?.();
      if (!modules) return false;
      for (const module of modules.values()) {
        if (!module.isInitialized || !module.verboseName?.endsWith("stores/session-store.ts")) {
          continue;
        }
        const store = module.publicModule?.exports?.useSessionStore as
          | {
              setState: (
                update: (state: {
                  sessions: Record<string, { agentTasks: Map<string, unknown> }>;
                }) => unknown,
              ) => void;
            }
          | undefined;
        if (!store) return false;
        store.setState((state) => {
          const session = state.sessions[serverId];
          if (!session) return state;
          return {
            ...state,
            sessions: {
              ...state.sessions,
              [serverId]: {
                ...session,
                agentTasks: new Map(session.agentTasks).set(targetAgentId, tasks),
              },
            },
          };
        });
        return true;
      }
      return false;
    },
    { serverId: getServerId(), targetAgentId: agentId, tasks: FIXTURE_TASKS },
  );
}

async function boxOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).filter({ visible: true }).first().boundingBox();
  if (!box) throw new Error(`No box for ${testId}`);
  return box;
}

/**
 * Waits for the compact overlay's slide to end: open, its header starts at the left edge; closed,
 * it is not in the viewport at all (to the right of it, or not displayed).
 */
async function expectOverlayAtRest(page: Page, state: "open" | "closed"): Promise<void> {
  const viewportWidth = page.viewportSize()?.width ?? 0;
  await expect
    .poll(async () => {
      const box = await page.getByTestId("explorer-header").first().boundingBox();
      if (!box || box.width === 0) return "closed";
      if (Math.round(box.x) === 0) return "open";
      return box.x >= viewportWidth ? "closed" : `sliding at ${Math.round(box.x)}`;
    })
    .toBe(state);
}

test.describe("task rail on a wide layout", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("is docked at 240 with `no tasks`, and leaves the chat column 880", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "lane-b-rail-empty-",
      title: "rail without tasks",
    });
    try {
      await openAgentRoute(page, agent);

      const empty = page.getByTestId("task-sidebar-empty").filter({ visible: true }).first();
      await expect(empty).toHaveText("no tasks");
      await expect(page.getByTestId("task-sidebar-list")).toHaveCount(0);

      const rail = await boxOf(page, "explorer-header");
      const leftEdge = await boxOf(page, "left-sidebar-resize-handle");
      // The header sits inside the rail's 1px left border: the rail itself starts at 1200.
      expect(Math.round(rail.x + rail.width)).toBe(1440);
      expect(Math.round(rail.x) - 1).toBe(1440 - 240);
      // The chat column is what is left between the two panels at their defaults (320 and 240).
      // The left handle's hit area straddles the left sidebar's edge, so its centre is that edge.
      const leftSidebarEdge = Math.round(leftEdge.x + leftEdge.width / 2);
      expect(leftSidebarEdge).toBe(320);
      expect(1440 - 240 - leftSidebarEdge).toBe(880);
      await shot(page, "B-rail-no-tasks-1440x1000.png");

      // The header toggle closes the rail and opens it again.
      const toggle = page.getByTestId("workspace-explorer-toggle").first();
      await toggle.click();
      await expect(page.getByTestId("task-sidebar-empty")).not.toBeVisible();
      await toggle.click();
      await expect(empty).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });

  test("shows a live list with the meter and opens a row in place", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "lane-b-rail-list-",
      title: "rail with tasks",
      initialPrompt: ONE_TASK_PROMPT,
    });
    try {
      await openAgentRoute(page, agent);

      const summary = page.getByTestId("task-sidebar-summary").filter({ visible: true }).first();
      await expect(summary).toHaveText("tasks [.........] 0/1", { timeout: 30_000 });
      const row = page.getByTestId("task-sidebar-row").filter({ visible: true }).first();
      await expect(row).toContainText("stress-update-1");
      await expect(row).toHaveAttribute("aria-expanded", "false");
      await shot(page, "B-rail-live-list-1440x1000.png");

      await row.click();
      await expect(row).toHaveAttribute("aria-expanded", "true");
      await row.click();
      await expect(row).toHaveAttribute("aria-expanded", "false");

      // Fixture for the screenshots: every state, a note, done and dropped folded.
      test.skip(!(await injectFixtureTasks(page, agent.agentId)), "Metro module registry needed");
      await expect(summary).toHaveText("tasks [|||......] 3/9");
      await expect(page.getByTestId("task-sidebar-section-running-header")).toContainText(
        "now · 1",
      );
      await expect(page.getByTestId("task-sidebar-section-decision-header")).toContainText(
        "ask · 1",
      );
      await expect(page.getByTestId("task-sidebar-section-pending-header")).toContainText(
        "todo · 3",
      );
      await expect(page.getByTestId("task-sidebar-section-hold-header")).toContainText("hold · 1");
      const done = page.getByTestId("task-sidebar-section-completed-header");
      await expect(done).toHaveText("[x]3 done ▸");
      await expect(page.getByTestId("task-sidebar-section-deleted-header")).toHaveText(
        "[-]1 dropped ▸",
      );
      // The task in progress shows what it is doing without a press; its note waits for one.
      const running = page
        .getByTestId("task-sidebar-section-running")
        .getByTestId("task-sidebar-row");
      await expect(running).toContainText("Fixing the minimum width");
      await expect(running).not.toContainText("Rows keep the checkbox markers");
      const rowHeight = (await running.boundingBox())?.height ?? 0;
      await shot(page, "B-rail-fixture-list-1440x1000.png");

      await running.click();
      await expect(running).toContainText("Rows keep the checkbox markers of delta 116.");
      expect((await running.boundingBox())?.height ?? 0).toBeGreaterThan(rowHeight);
      await done.click();
      await expect(done).toHaveText("[x]3 done ▾");
      await expect(page.getByTestId("task-sidebar-section-completed")).toContainText(
        "Read the plan",
      );
      await shot(page, "B-rail-fixture-row-expanded-1440x1000.png");
    } finally {
      await agent.cleanup();
    }
  });
});

test.describe("task panel on a compact layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stays closed until its toggle, with the same rows", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "lane-b-rail-compact-",
      title: "compact tasks",
      initialPrompt: ONE_TASK_PROMPT,
    });
    try {
      await openAgentRoute(page, agent);
      const toggle = page
        .getByTestId("workspace-explorer-toggle")
        .filter({ visible: true })
        .first();
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");

      // Closed, the overlay is fully off screen: nothing of it inside the 390 viewport.
      await expectOverlayAtRest(page, "closed");
      await shot(page, "B-rail-closed-390x844.png");

      await toggle.click();
      const summary = page.getByTestId("task-sidebar-summary").filter({ visible: true }).first();
      await expect(summary).toHaveText("tasks [.........] 0/1", { timeout: 30_000 });
      await expectOverlayAtRest(page, "open");
      await shot(page, "B-rail-live-list-390x844.png");

      if (await injectFixtureTasks(page, agent.agentId)) {
        await expect(summary).toHaveText("tasks [|||......] 3/9");
        await shot(page, "B-rail-fixture-list-390x844.png");
        const running = page
          .getByTestId("task-sidebar-section-running")
          .filter({ visible: true })
          .getByTestId("task-sidebar-row");
        await running.click();
        await expect(running).toHaveAttribute("aria-expanded", "true");
        await shot(page, "B-rail-fixture-row-expanded-390x844.png");
      }
    } finally {
      await agent.cleanup();
    }
  });

  test("shows `no tasks` for a session without a list", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "lane-b-rail-compact-empty-",
      title: "compact without tasks",
    });
    try {
      await openAgentRoute(page, agent);
      const toggle = page
        .getByTestId("workspace-explorer-toggle")
        .filter({ visible: true })
        .first();
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      await toggle.click();
      await expect(
        page.getByTestId("task-sidebar-empty").filter({ visible: true }).first(),
      ).toHaveText("no tasks");
      await expectOverlayAtRest(page, "open");
      await shot(page, "B-rail-no-tasks-390x844.png");
    } finally {
      await agent.cleanup();
    }
  });
});
