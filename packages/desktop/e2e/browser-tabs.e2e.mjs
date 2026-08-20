#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import { runAppearanceFontSizeRegression } from "./appearance-font-size.electron.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const devRunner = path.join(desktopDir, "scripts", "dev-runner.mjs");
const workspaceIds = [
  "desktop-browser-original",
  "desktop-browser-evict-one",
  "desktop-browser-evict-two",
  "desktop-browser-evict-three",
];
const timeoutMs = 90_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === "string") {
          return reject(new Error("Failed to reserve a local port"));
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForPort(port, label, processInfo) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      processInfo &&
      (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null)
    ) {
      throw new Error(
        `${label} process exited before opening its port; see ${processInfo.logPath}`,
      );
    }
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label} on port ${port}`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function seedPaseoHome(paseoHome, listen, workspaceRoot) {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const projects = workspaceIds.map((workspaceId, index) => {
    const cwd = path.join(workspaceRoot, `workspace-${index + 1}`);
    fs.mkdirSync(cwd, { recursive: true });
    return {
      projectId: `project-${workspaceId}`,
      rootPath: cwd,
      kind: "non_git",
      displayName: `Desktop browser project ${index + 1}`,
      customName: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
  });
  const workspaces = workspaceIds.map((workspaceId, index) => ({
    workspaceId,
    projectId: projects[index].projectId,
    cwd: projects[index].rootPath,
    kind: "directory",
    displayName: `Desktop browser workspace ${index + 1}`,
    title: `Desktop browser workspace ${index + 1}`,
    branch: null,
    baseBranch: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    pinnedAt: null,
  }));

  writeJson(path.join(paseoHome, "config.json"), {
    version: 1,
    daemon: {
      listen,
      relay: { enabled: false },
      mcp: { enabled: true, injectIntoAgents: false },
      browserTools: { enabled: true },
      cors: { allowedOrigins: ["*"] },
    },
  });
  writeJson(path.join(paseoHome, "projects", "projects.json"), projects);
  writeJson(path.join(paseoHome, "projects", "workspaces.json"), workspaces);
}

function spawnLogged(name, command, args, options, logDir) {
  const logPath = path.join(logDir, `${name}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let openStreams = 2;
  const closeLogStream = () => {
    openStreams -= 1;
    if (openStreams === 0) log.end();
  };
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.stdout.once("end", closeLogStream);
  child.stderr.once("end", closeLogStream);
  return { child, logPath };
}

function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // The process may exit between the liveness check and signal delivery.
  }
}

async function waitForAppPage(browser, expoPort) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes(`localhost:${expoPort}`)) return page;
      }
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the real Electron app renderer");
}

async function waitForDesktopStatus(page) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const status = await page.evaluate(async () => {
        if (typeof window.paseoDesktop?.invoke !== "function") return null;
        return await window.paseoDesktop.invoke("desktop_daemon_status");
      });
      if (typeof status?.serverId === "string") return status;
    } catch (error) {
      // Metro may replace the renderer execution context during its initial load.
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for the Electron desktop bridge${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

async function startTargetPage() {
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (requestUrl.pathname === "/popup") {
      const label = requestUrl.searchParams.get("label") ?? "Popup";
      response.end(`<!doctype html>
        <html>
          <head><title>${label}</title></head>
          <body>
            <h1 id="popup-title">${label}</h1>
            <button id="notify-opener" onclick="window.opener.postMessage('popup-ready:${label}', '*')">Notify opener</button>
            <button id="alert-popup" onclick="window.alert('popup-alert')">Show alert</button>
            <button id="schedule-confirm" onclick="setTimeout(() => window.confirm('delayed-confirm'), 100)">Schedule confirm</button>
            <button id="open-nested" onclick="window.__nestedPopup = window.open('/popup?label=Nested', 'nested-popup', 'width=420,height=320')">Open nested</button>
            <button id="close-popup" onclick="window.close()">Close popup</button>
            <script>console.info('popup-console:${label}')</script>
          </body>
        </html>`);
      return;
    }
    if (requestUrl.pathname === "/focus-attempt") {
      response.end(`<!doctype html>
        <html>
          <head><title>Background focus attempt</title></head>
          <body>
            <label for="background-autofocus">Background autofocus</label>
            <input id="background-autofocus" autofocus />
            <script>
              window.focus();
              setTimeout(() => document.querySelector('#background-autofocus').focus(), 250);
            </script>
          </body>
        </html>`);
      return;
    }
    if (requestUrl.pathname === "/post-popup") {
      let body = "";
      for await (const chunk of request) body += chunk;
      response.end(`<!doctype html>
        <html>
          <head><title>POST popup</title></head>
          <body><h1>POST popup</h1><p id="post-body">${body}</p><button id="close-popup" onclick="window.close()">Close popup</button></body>
        </html>`);
      return;
    }
    response.end(`<!doctype html>
      <html>
        <head><title>Desktop browser target</title></head>
        <body>
          <button id="bridge-target" onclick="this.textContent = 'Clicked'">Bridge target</button>
          <label for="typing-target">Typing target</label>
          <input id="typing-target" />
          <button id="open-human-popup" onclick="window.__humanPopup = window.open('/popup?label=Human', 'human-popup', 'width=520,height=420')">Open human popup</button>
          <form id="post-popup-form" action="/post-popup" method="post" target="post-popup">
            <input name="token" value="safe-value" />
            <button id="open-post-popup" type="submit">Open POST popup</button>
          </form>
          <p id="opener-message">No popup message</p>
          <script>
            window.addEventListener('message', (event) => {
              document.querySelector('#opener-message').textContent = event.data;
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Target page did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function mcpPayload(result, command) {
  const payload = result.structuredContent;
  assert(
    payload && typeof payload === "object",
    `${command} returned no structured payload: ${JSON.stringify(result)}`,
  );
  assert(payload.ok === true, `${command} failed: ${JSON.stringify(payload)}`);
  return payload.result;
}

async function callBrowserTool(client, name, args = {}) {
  return mcpPayload(await client.callTool({ name, args }), name);
}

async function waitForGuestSelector(client, browserId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const evaluated = await callBrowserTool(client, "browser_evaluate", {
      browserId,
      function: "() => Boolean(globalThis.__paseoSelector)",
    });
    if (JSON.parse(evaluated.resultJson) === true) {
      return true;
    }
    await delay(50);
  }
  return false;
}

async function createCallerAgent(daemonPort, workspaceId = workspaceIds[0]) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${daemonPort}/mcp/agents`),
  );
  const client = await experimental_createMCPClient({ transport });
  try {
    const response = await client.callTool({
      name: "create_agent",
      args: {
        relationship: { kind: "detached" },
        workspace: { kind: "existing", workspaceId },
        title: `Browser desktop browser E2E caller ${workspaceId}`,
        provider: "mock/ten-second-stream",
        settings: { modeId: "load-test" },
        initialPrompt: "Remain available while the browser bridge regression runs.",
        background: true,
      },
    });
    const result = response.structuredContent;
    assert(
      result && typeof result === "object",
      `create_agent returned no structured payload: ${JSON.stringify(response)}`,
    );
    assert(typeof result.agentId === "string", "create_agent returned no caller agent id");
    assert(
      result.workspaceId === workspaceId,
      `MCP caller attached to unexpected workspace ${result.workspaceId}`,
    );
    return result.agentId;
  } finally {
    await client.close();
  }
}

async function readGuest(page, browserId) {
  return await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement) || typeof webview.getWebContentsId !== "function") {
      return null;
    }
    return {
      webContentsId: webview.getWebContentsId(),
      parentId: webview.parentElement?.id ?? null,
      width: Math.round(webview.getBoundingClientRect().width),
      height: Math.round(webview.getBoundingClientRect().height),
    };
  }, browserId);
}

async function readPresentation(page, browserId) {
  return await page.evaluate((id) => {
    const surface = document.querySelector(`[data-paseo-browser-surface="${id}"]`);
    const clip = document.querySelector(`[data-testid="browser-webview-clip-${id}"]`);
    if (!(surface instanceof HTMLElement) || !(clip instanceof HTMLElement)) return null;
    const surfaceRect = surface.getBoundingClientRect();
    const clipRect = clip.getBoundingClientRect();
    const webview = surface.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) return null;
    const webviewRect = webview.getBoundingClientRect();
    const outsidePoint = {
      x: Math.max(0, Math.round(clipRect.left - 1)),
      y: Math.round(clipRect.top + clipRect.height / 2),
    };
    const outsideTarget = document.elementFromPoint(outsidePoint.x, outsidePoint.y);
    return {
      surface: {
        left: Math.round(surfaceRect.left),
        top: Math.round(surfaceRect.top),
        right: Math.round(surfaceRect.right),
        bottom: Math.round(surfaceRect.bottom),
      },
      clip: {
        left: Math.round(clipRect.left),
        top: Math.round(clipRect.top),
        right: Math.round(clipRect.right),
        bottom: Math.round(clipRect.bottom),
      },
      webview: {
        left: Math.round(webviewRect.left),
        top: Math.round(webviewRect.top),
      },
      capturesOutsideInput: surface.contains(outsideTarget),
    };
  }, browserId);
}

async function readViewport(client, browserId) {
  const evaluated = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => ({ width: window.innerWidth, height: window.innerHeight })",
  });
  return JSON.parse(evaluated.resultJson);
}

async function clickGuestElement(page, client, browserId, selector) {
  const evaluated = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: `() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }`,
  });
  const elementRect = JSON.parse(evaluated.resultJson);
  assert(elementRect, `Guest element ${selector} was unavailable`);
  const webviewRect = await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) return null;
    const rect = webview.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  }, browserId);
  assert(webviewRect, `Browser webview ${browserId} was unavailable`);
  await page.mouse.click(
    webviewRect.x + elementRect.x + elementRect.width / 2,
    webviewRect.y + elementRect.y + elementRect.height / 2,
  );
}

async function clickGuestElementAsHuman(page, browserId, selector) {
  const target = await page.evaluate(
    async ({ id, selectorValue }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      if (!(webview instanceof HTMLElement) || typeof webview.executeJavaScript !== "function") {
        return null;
      }
      const elementRect = await webview.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selectorValue)});
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`);
      const webviewRect = webview.getBoundingClientRect();
      return elementRect
        ? {
            x: webviewRect.x + elementRect.x + elementRect.width / 2,
            y: webviewRect.y + elementRect.y + elementRect.height / 2,
          }
        : null;
    },
    { id: browserId, selectorValue: selector },
  );
  assert(target, `Guest element ${selector} was unavailable for human input`);
  await page.mouse.click(target.x, target.y);
}

async function waitForPopupTabs(client, rootBrowserId, expectedCount) {
  const deadline = Date.now() + 5_000;
  let lastTabs = [];
  while (Date.now() < deadline) {
    const listed = await callBrowserTool(client, "browser_list_tabs");
    lastTabs = listed.tabs;
    const popups = listed.tabs.filter(
      (tab) => tab.kind === "popup" && tab.rootBrowserId === rootBrowserId,
    );
    if (popups.length === expectedCount) return { listed, popups };
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${expectedCount} popup targets under ${rootBrowserId}: ${JSON.stringify(lastTabs)}`,
  );
}

async function readPopupTargets(page, rootBrowserId) {
  return await page.evaluate(
    (id) => window.paseoDesktop?.browser?.listPopupTargets?.(id) ?? null,
    rootBrowserId,
  );
}

async function waitForPopupVisibility(page, rootBrowserId, popupBrowserId, expectedVisible) {
  const deadline = Date.now() + 5_000;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    lastSnapshot = await readPopupTargets(page, rootBrowserId);
    const popup = lastSnapshot?.targets?.find((target) => target.browserId === popupBrowserId);
    if (popup?.isVisible === expectedVisible) return popup;
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for popup ${popupBrowserId} visibility=${expectedVisible}: ${JSON.stringify(lastSnapshot)}`,
  );
}

async function selectDeviceSize(page, label) {
  await page.locator('[aria-label="Device size"]').click();
  const item = page.getByText(label, { exact: true });
  await item.waitFor({ state: "visible", timeout: timeoutMs });
  const rect = await item.boundingBox();
  assert(rect, `Device size menu item ${label} had no bounds`);
  const clip = {
    x: Math.max(0, rect.x),
    y: Math.max(0, rect.y),
    width: rect.width,
    height: rect.height,
  };
  const openPixels = await page.screenshot({ clip });
  await page.keyboard.press("Escape");
  await item.waitFor({ state: "hidden", timeout: timeoutMs });
  const closedPixels = await page.screenshot({ clip });

  await page.locator('[aria-label="Device size"]').click();
  await item.waitFor({ state: "visible", timeout: timeoutMs });
  const clickRect = await item.boundingBox();
  assert(clickRect, `Device size menu item ${label} lost its bounds after reopening`);
  await page.mouse.click(clickRect.x + clickRect.width / 2, clickRect.y + clickRect.height / 2);
  await page.keyboard.press("Escape");
  return !openPixels.equals(closedPixels);
}

function recordViewportMismatch(failures, label, actual, expected) {
  if (actual.width === expected.width && actual.height === expected.height) {
    return;
  }
  failures.push(
    `${label}: expected ${expected.width}x${expected.height}, received ${actual.width}x${actual.height}`,
  );
}

async function capturePopupStreamFrame(page, popupBrowserId, workspaceId) {
  return await page.evaluate(
    async ({ targetBrowserId, targetWorkspaceId }) => {
      const browser = window.paseoDesktop?.browser;
      if (!browser?.executeAutomationCommand || !browser.onStreamFrame) return null;
      let dispose = () => {};
      const framePromise = new Promise((resolve) => {
        dispose = browser.onStreamFrame((frame) => {
          if (frame?.browserId !== targetBrowserId) return;
          resolve({
            width: frame.width,
            height: frame.height,
            dataLength: frame.dataBase64.length,
          });
        });
      });
      const started = await browser.executeAutomationCommand({
        type: "browser.automation.execute.request",
        requestId: "popup-stream-start",
        workspaceId: targetWorkspaceId,
        command: { command: "stream_start", args: { browserId: targetBrowserId, quality: 40 } },
      });
      const frame = started?.ok
        ? await Promise.race([
            framePromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
          ])
        : null;
      await browser.executeAutomationCommand({
        type: "browser.automation.execute.request",
        requestId: "popup-stream-stop",
        workspaceId: targetWorkspaceId,
        command: { command: "stream_stop", args: { browserId: targetBrowserId } },
      });
      dispose();
      return frame;
    },
    { targetBrowserId: popupBrowserId, targetWorkspaceId: workspaceId },
  );
}

async function ensureHumanPopupPresented({ page, originalDeck, rootBrowserId, popupBrowserId }) {
  const snapshot = await readPopupTargets(page, rootBrowserId);
  const alreadyVisible = snapshot?.targets?.find(
    (target) => target.browserId === popupBrowserId,
  )?.isVisible;
  if (!alreadyVisible) {
    // CDP mouse injection does not focus the native BrowserWindow on every CI host. The
    // activation decision itself is covered by the manager unit test; this path still proves
    // that a physically created popup can be presented without an OS child window.
    await originalDeck.getByRole("button", { name: "Show pop-ups (1)" }).click();
  }
  await waitForPopupVisibility(page, rootBrowserId, popupBrowserId, true);
}

async function runPopupRegression({
  page,
  client,
  browserId,
  originalDeck,
  serverId,
  targetUrl,
  artifactDir,
}) {
  const agentOpen = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function:
      "() => Boolean(window.__agentPopup = window.open('/popup?label=Agent', 'agent-popup', 'width=520,height=420'))",
  });
  assert(JSON.parse(agentOpen.resultJson) === true, "Agent popup did not return a WindowProxy");

  let popupState = await waitForPopupTabs(client, browserId, 1);
  const agentPopup = popupState.popups[0];
  assert(agentPopup, "Agent popup was not registered");
  assert(agentPopup.openerBrowserId === browserId, "Agent popup lost its direct opener");
  assert(agentPopup.isActive === false, "Agent popup stole the user's active browser target");
  await waitForPopupVisibility(page, browserId, agentPopup.browserId, false);
  await originalDeck
    .getByRole("button", { name: "Show pop-ups (1)" })
    .waitFor({ state: "visible", timeout: 5_000 });

  const popupSnapshot = await callBrowserTool(client, "browser_snapshot", {
    browserId: agentPopup.browserId,
  });
  const notifyRef = popupSnapshot.snapshot.match(/button "Notify opener" \[ref=(@e\d+)\]/)?.[1];
  assert(notifyRef, `Popup snapshot did not expose its controls: ${popupSnapshot.snapshot}`);
  const popupHitTest = await callBrowserTool(client, "browser_evaluate", {
    browserId: agentPopup.browserId,
    function: `() => {
      const element = document.querySelector('#notify-opener');
      const rect = element?.getBoundingClientRect();
      const point = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      const hit = point ? document.elementFromPoint(point.x, point.y) : null;
      return {
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        innerWidth,
        innerHeight,
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        hitId: hit?.id ?? null,
      };
    }`,
  });
  const hiddenPopupHitTest = JSON.parse(popupHitTest.resultJson);
  assert(
    hiddenPopupHitTest.innerWidth === 520 && hiddenPopupHitTest.innerHeight === 420,
    `Background popup lost its viewport: ${popupHitTest.resultJson}`,
  );
  assert(
    hiddenPopupHitTest.hitId === "notify-opener",
    `Background popup lost DOM hit testing: ${popupHitTest.resultJson}`,
  );
  const popupScreenshot = await callBrowserTool(client, "browser_screenshot", {
    browserId: agentPopup.browserId,
  });
  assert(
    popupScreenshot.width === 520 && popupScreenshot.height === 420,
    `Background popup screenshot lost its viewport: ${JSON.stringify(popupScreenshot)}`,
  );
  const popupStreamFrame = await capturePopupStreamFrame(
    page,
    agentPopup.browserId,
    "desktop-browser-original",
  );
  assert(
    popupStreamFrame?.width === 520 &&
      popupStreamFrame?.height === 420 &&
      popupStreamFrame?.dataLength > 0,
    `Background popup stream produced no real frame: ${JSON.stringify(popupStreamFrame)}`,
  );
  await callBrowserTool(client, "browser_resize", {
    browserId: agentPopup.browserId,
    width: 640,
    height: 480,
  });
  const resizedPopupViewport = await callBrowserTool(client, "browser_evaluate", {
    browserId: agentPopup.browserId,
    function: "() => ({ width: innerWidth, height: innerHeight })",
  });
  assert(
    resizedPopupViewport.resultJson === '{"width":640,"height":480}',
    `Background popup resize did not reach Chromium: ${resizedPopupViewport.resultJson}`,
  );
  await callBrowserTool(client, "browser_click", {
    browserId: agentPopup.browserId,
    ref: notifyRef,
  });
  const alertSnapshot = await callBrowserTool(client, "browser_snapshot", {
    browserId: agentPopup.browserId,
  });
  const alertRef = alertSnapshot.snapshot.match(/button "Show alert" \[ref=(@e\d+)\]/)?.[1];
  assert(alertRef, `Popup snapshot did not expose its alert control: ${alertSnapshot.snapshot}`);
  const alertResponse = await client.callTool({
    name: "browser_click",
    args: { browserId: agentPopup.browserId, ref: alertRef },
  });
  assert(
    alertResponse.structuredContent?.dialogs?.some(
      (dialog) =>
        dialog.type === "alert" && dialog.message === "popup-alert" && dialog.action === "accepted",
    ),
    `Popup alert was not captured and handled: ${JSON.stringify(alertResponse.structuredContent)}`,
  );
  const delayedSnapshot = await callBrowserTool(client, "browser_snapshot", {
    browserId: agentPopup.browserId,
  });
  const delayedRef = delayedSnapshot.snapshot.match(
    /button "Schedule confirm" \[ref=(@e\d+)\]/,
  )?.[1];
  assert(
    delayedRef,
    `Popup snapshot did not expose delayed dialog control: ${delayedSnapshot.snapshot}`,
  );
  await callBrowserTool(client, "browser_click", {
    browserId: agentPopup.browserId,
    ref: delayedRef,
  });
  await delay(200);
  const afterDelayedDialog = await client.callTool({
    name: "browser_snapshot",
    args: { browserId: agentPopup.browserId },
  });
  assert(
    afterDelayedDialog.structuredContent?.dialogs?.some(
      (dialog) =>
        dialog.type === "confirm" &&
        dialog.message === "delayed-confirm" &&
        dialog.action === "dismissed",
    ),
    `Background popup dialog was not queued for the agent: ${JSON.stringify(afterDelayedDialog.structuredContent)}`,
  );
  await callBrowserTool(client, "browser_wait", {
    browserId,
    text: "popup-ready:Agent",
    timeoutMs: 5_000,
  });
  const popupLogs = await callBrowserTool(client, "browser_logs", {
    browserId: agentPopup.browserId,
  });
  assert(
    popupLogs.console.some((entry) => entry.message.includes("popup-console:Agent")),
    "Popup console logs were not available to the agent",
  );

  await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function:
      "() => Boolean(window.__agentPopup === window.open('/popup?label=Reused', 'agent-popup', 'width=600,height=440'))",
  });
  await callBrowserTool(client, "browser_wait", {
    browserId: agentPopup.browserId,
    url: "label=Reused",
    timeoutMs: 5_000,
  });
  popupState = await waitForPopupTabs(client, browserId, 1);
  assert(
    popupState.popups[0]?.browserId === agentPopup.browserId,
    "Named popup reuse created a second target",
  );

  await callBrowserTool(client, "browser_evaluate", {
    browserId: agentPopup.browserId,
    function:
      "() => Boolean(window.__nestedPopup = window.open('/popup?label=Nested', 'nested-popup', 'width=420,height=320'))",
  });
  popupState = await waitForPopupTabs(client, browserId, 2);
  const nestedPopup = popupState.popups.find(
    (target) => target.openerBrowserId === agentPopup.browserId,
  );
  assert(nestedPopup, "Nested popup did not retain its direct popup opener");

  await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => { document.querySelector('#post-popup-form').requestSubmit(); return true; }",
  });
  popupState = await waitForPopupTabs(client, browserId, 3);
  const postPopup = popupState.popups.find((target) => target.title === "POST popup");
  assert(postPopup, `POST popup was not registered: ${JSON.stringify(popupState.popups)}`);
  const postSnapshot = await callBrowserTool(client, "browser_snapshot", {
    browserId: postPopup.browserId,
  });
  assert(
    postSnapshot.snapshot.includes("token=safe-value"),
    `POST body was not preserved in the adopted popup: ${postSnapshot.snapshot}`,
  );

  await originalDeck.getByRole("button", { name: "Show pop-ups (3)" }).click();
  await waitForPopupVisibility(page, browserId, postPopup.browserId, true);
  await page.screenshot({ path: path.join(artifactDir, "popup-presented.png") });
  const urlInput = originalDeck.getByRole("textbox", { name: "Browser URL" });
  assert(
    (await urlInput.inputValue()).includes("/post-popup"),
    "Selecting the popup did not update the browser URL bar",
  );
  popupState = await waitForPopupTabs(client, browserId, 3);
  assert(
    popupState.popups.find((target) => target.browserId === postPopup.browserId)?.isActive === true,
    "Visible popup was not the active browser target",
  );

  // Keep the popup selected while switching workspaces. Main may receive the
  // pane presentation before the foreground report; the desired presentation
  // must be replayed automatically when this workspace wins again.
  await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[1]}`).click();
  await waitForPopupVisibility(page, browserId, postPopup.browserId, false);
  await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[0]}`).click();
  await originalDeck.waitFor({ state: "visible", timeout: timeoutMs });
  await waitForPopupVisibility(page, browserId, postPopup.browserId, true);

  // A non-workspace route is an explicit no-owner state, not unknown/fail-open.
  await page.getByTestId("sidebar-settings").click();
  await page.getByTestId("settings-sidebar").waitFor({ state: "visible", timeout: timeoutMs });
  await waitForPopupVisibility(page, browserId, postPopup.browserId, false);
  await page.getByTestId("settings-back-to-workspace").click();
  await originalDeck.waitFor({ state: "visible", timeout: timeoutMs });
  await waitForPopupVisibility(page, browserId, postPopup.browserId, true);

  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "visible-popup-focus-sentinel";
    input.value = "keep-visible-popup-focus";
    input.style.position = "fixed";
    input.style.left = "8px";
    input.style.bottom = "40px";
    input.style.zIndex = "100000";
    document.body.appendChild(input);
    input.focus();
  });
  await callBrowserTool(client, "browser_navigate", {
    browserId: postPopup.browserId,
    url: new URL("/popup?label=Navigated", targetUrl).toString(),
  });
  await callBrowserTool(client, "browser_wait", {
    browserId: postPopup.browserId,
    text: "Navigated",
    timeoutMs: 5_000,
  });
  assert(
    await page.evaluate(() => document.activeElement?.id === "visible-popup-focus-sentinel"),
    "Visible popup navigation stole focus from the user's host input",
  );
  await page.evaluate(() => document.querySelector("#visible-popup-focus-sentinel")?.remove());

  await page.getByTestId("sidebar-command-center-search").click();
  await page.getByTestId("command-center-panel").waitFor({ state: "visible", timeout: 5_000 });
  await waitForPopupVisibility(page, browserId, postPopup.browserId, false);
  await page.keyboard.press("Escape");
  await page.getByTestId("command-center-panel").waitFor({ state: "hidden", timeout: 5_000 });
  await waitForPopupVisibility(page, browserId, postPopup.browserId, true);

  await originalDeck.getByRole("button", { name: "Previous pop-up" }).click();
  await waitForPopupVisibility(page, browserId, nestedPopup.browserId, true);
  await callBrowserTool(client, "browser_evaluate", {
    browserId: nestedPopup.browserId,
    function: "() => { setTimeout(() => window.close(), 0); return true; }",
  });
  await waitForPopupTabs(client, browserId, 2);
  const nestedClosed = await callBrowserTool(client, "browser_evaluate", {
    browserId: agentPopup.browserId,
    function: "() => window.__nestedPopup?.closed ?? null",
  });
  assert(
    JSON.parse(nestedClosed.resultJson) === true,
    "window.close did not close the nested target",
  );

  await originalDeck.getByRole("button", { name: "Show pop-ups (2)" }).click();
  await waitForPopupVisibility(page, browserId, postPopup.browserId, true);
  await originalDeck.getByRole("button", { name: "Close pop-up" }).click();
  await waitForPopupTabs(client, browserId, 1);

  await callBrowserTool(client, "browser_close_tab", { browserId: agentPopup.browserId });
  await waitForPopupTabs(client, browserId, 0);
  const namedClosed = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => window.__agentPopup?.closed ?? null",
  });
  assert(JSON.parse(namedClosed.resultJson) === true, "Agent close did not close the WindowProxy");

  await delay(1_100);
  await page.bringToFront();
  await page.evaluate((id) => window.paseoDesktop?.browser?.focus?.(id), browserId);
  await clickGuestElementAsHuman(page, browserId, "#open-human-popup");
  popupState = await waitForPopupTabs(client, browserId, 1);
  const humanPopup = popupState.popups[0];
  assert(humanPopup, "Human popup was not registered");
  await ensureHumanPopupPresented({
    page,
    originalDeck,
    rootBrowserId: browserId,
    popupBrowserId: humanPopup.browserId,
  });
  await originalDeck.getByRole("button", { name: "Return to page" }).click();
  await waitForPopupVisibility(page, browserId, humanPopup.browserId, false);
  await callBrowserTool(client, "browser_close_tab", { browserId: humanPopup.browserId });
  await waitForPopupTabs(client, browserId, 0);

  await page.evaluate(async (id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement) || typeof webview.executeJavaScript !== "function") {
      throw new Error("Browser webview unavailable for delayed popup");
    }
    await webview.executeJavaScript(
      "setTimeout(() => window.open('/popup?label=Background', 'background-popup', 'width=480,height=360'), 300); true",
    );
  }, browserId);
  await urlInput.click();
  await urlInput.fill("focus-continuity-sentinel");
  popupState = await waitForPopupTabs(client, browserId, 1);
  const backgroundPopup = popupState.popups[0];
  assert(backgroundPopup, "Delayed background popup was not registered");
  await waitForPopupVisibility(page, browserId, backgroundPopup.browserId, false);
  assert(
    (await urlInput.inputValue()) === "focus-continuity-sentinel",
    "Background popup interrupted the host URL input",
  );
  assert(
    await urlInput.evaluate((input) => input === document.activeElement),
    "Background popup stole DOM focus",
  );
  await callBrowserTool(client, "browser_close_tab", { browserId: backgroundPopup.browserId });
  await waitForPopupTabs(client, browserId, 0);
  await urlInput.fill(targetUrl);

  return {
    opener: "passed",
    post: "passed",
    namedReuse: "passed",
    nested: "passed",
    close: "passed",
    agentControl: "passed",
    humanPresentation: "passed",
    backgroundFocus: "passed",
    overlayContainment: "passed",
  };
}

async function runRegression({
  page,
  client,
  backgroundClient,
  serverId,
  targetUrl,
  callerAgentId,
  artifactDir,
}) {
  const failures = [];
  const originalWorkspaceId = workspaceIds[0];
  const originalWorkspaceRow = page.getByTestId(
    `sidebar-workspace-row-${serverId}:${originalWorkspaceId}`,
  );
  await originalWorkspaceRow.waitFor({ state: "visible", timeout: timeoutMs });
  await originalWorkspaceRow.click();

  await page.evaluate(() => {
    if (document.getElementById("overlay-root")) return;
    const overlayRoot = document.createElement("div");
    overlayRoot.id = "overlay-root";
    overlayRoot.style.position = "fixed";
    overlayRoot.style.inset = "0";
    overlayRoot.style.pointerEvents = "none";
    document.body.appendChild(overlayRoot);
  });

  const created = await callBrowserTool(client, "browser_new_tab", { url: targetUrl });
  const browserId = created.browserId;
  assert(typeof browserId === "string", "browser_new_tab returned no browserId");

  const originalDeck = page.getByTestId(`workspace-deck-entry-${serverId}:${originalWorkspaceId}`);
  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
  await page.waitForFunction(
    (id) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return webview && webview.parentElement?.id !== "paseo-browser-resident-webviews";
    },
    browserId,
    { timeout: timeoutMs },
  );
  const firstGuest = await readGuest(page, browserId);
  assert(firstGuest, "Original browser guest was not attached to its workspace pane");
  recordViewportMismatch(
    failures,
    "Responsive viewport follows the visible browser pane",
    await readViewport(client, browserId),
    { width: firstGuest.width, height: firstGuest.height },
  );

  await clickGuestElement(page, client, browserId, "#typing-target");
  const activeGuestElement = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => document.activeElement?.id ?? null",
  });
  assert(
    JSON.parse(activeGuestElement.resultJson) === "typing-target",
    "Physical browser click did not focus the guest input",
  );
  const focusedGuest = await page.evaluate(
    (id) => window.paseoDesktop?.browser?.focus?.(id),
    browserId,
  );
  assert(focusedGuest === true, "Electron did not focus the registered browser guest");

  await page.evaluate(() => {
    document.querySelector("#cross-session-focus-sentinel")?.remove();
    const input = document.createElement("input");
    input.id = "cross-session-focus-sentinel";
    input.value = "keep-user-focus";
    input.style.position = "fixed";
    input.style.left = "8px";
    input.style.bottom = "8px";
    input.style.zIndex = "100000";
    document.body.appendChild(input);
    input.focus();
  });
  const backgroundInputSnapshot = await callBrowserTool(client, "browser_snapshot", { browserId });
  const backgroundInputRef = backgroundInputSnapshot.snapshot.match(
    /textbox "Typing target" \[ref=(@e\d+)\]/,
  )?.[1];
  assert(backgroundInputRef, "Browser snapshot did not expose the background typing target");
  await callBrowserTool(client, "browser_fill", {
    browserId,
    ref: backgroundInputRef,
    value: "agent-background-input",
  });
  assert(
    await page.evaluate(() => document.activeElement?.id === "cross-session-focus-sentinel"),
    "Background browser input stole focus from the user's host input",
  );
  await callBrowserTool(client, "browser_navigate", {
    browserId,
    url: new URL("/focus-attempt", targetUrl).toString(),
  });
  await page.waitForTimeout(500);
  assert(
    await page.evaluate(() => document.activeElement?.id === "cross-session-focus-sentinel"),
    "Browser navigation stole focus from the user's host input",
  );
  await callBrowserTool(client, "browser_navigate", { browserId, url: targetUrl });
  await callBrowserTool(client, "browser_wait", {
    browserId,
    text: "Bridge target",
    timeoutMs: 5_000,
  });
  await page.evaluate(() => {
    const input = document.querySelector("#cross-session-focus-sentinel");
    if (input instanceof HTMLInputElement) {
      input.value = "keep-cross-workspace-focus";
      input.focus();
    }
  });
  const backgroundCreated = await callBrowserTool(backgroundClient, "browser_new_tab", {
    url: new URL("/focus-attempt", targetUrl).toString(),
  });
  await page.waitForTimeout(500);
  assert(
    await page.evaluate(() => document.activeElement?.id === "cross-session-focus-sentinel"),
    "A browser tab created by another workspace stole the user's host input focus",
  );
  const backgroundSnapshot = await callBrowserTool(backgroundClient, "browser_snapshot", {
    browserId: backgroundCreated.browserId,
  });
  const crossWorkspaceInputRef = backgroundSnapshot.snapshot.match(
    /textbox "Background autofocus" \[ref=(@e\d+)\]/,
  )?.[1];
  assert(crossWorkspaceInputRef, "Background workspace snapshot missed the typing target");
  await callBrowserTool(backgroundClient, "browser_fill", {
    browserId: backgroundCreated.browserId,
    ref: crossWorkspaceInputRef,
    value: "other-session-input",
  });
  assert(
    await page.evaluate(() => document.activeElement?.id === "cross-session-focus-sentinel"),
    "Browser fill from another workspace stole the user's host input focus",
  );
  await callBrowserTool(backgroundClient, "browser_click", {
    browserId: backgroundCreated.browserId,
    ref: crossWorkspaceInputRef,
  });
  assert(
    await page.evaluate(
      () =>
        document.activeElement?.id === "cross-session-focus-sentinel" &&
        document.querySelector("#cross-session-focus-sentinel")?.value ===
          "keep-cross-workspace-focus",
    ),
    "Browser click from another workspace interrupted the user's host input",
  );
  await callBrowserTool(backgroundClient, "browser_type", {
    browserId: backgroundCreated.browserId,
    ref: crossWorkspaceInputRef,
    text: "-typed-in-browser",
  });
  assert(
    await page.evaluate(
      () =>
        document.activeElement?.id === "cross-session-focus-sentinel" &&
        document.querySelector("#cross-session-focus-sentinel")?.value ===
          "keep-cross-workspace-focus",
    ),
    "Browser typing from another workspace crossed into the user's host input",
  );
  await callBrowserTool(backgroundClient, "browser_evaluate", {
    browserId: backgroundCreated.browserId,
    function:
      "() => { setTimeout(() => window.open('/popup?label=BackgroundWorkspace', 'background-workspace-popup', 'width=480,height=360'), 1200); return true; }",
  });
  const backgroundPopupState = await waitForPopupTabs(
    backgroundClient,
    backgroundCreated.browserId,
    1,
  );
  const backgroundPopup = backgroundPopupState.popups[0];
  assert(backgroundPopup, "Background workspace popup was not registered");
  assert(
    backgroundPopup.isActive === false,
    "A popup from another workspace became the agent's active target",
  );
  await waitForPopupVisibility(page, backgroundCreated.browserId, backgroundPopup.browserId, false);
  assert(
    await page.evaluate(() => document.activeElement?.id === "cross-session-focus-sentinel"),
    "A popup from another workspace stole the user's host input focus",
  );
  const backgroundPopupSnapshot = await callBrowserTool(backgroundClient, "browser_snapshot", {
    browserId: backgroundPopup.browserId,
  });
  const backgroundPopupRef = backgroundPopupSnapshot.snapshot.match(
    /button "Notify opener" \[ref=(@e\d+)\]/,
  )?.[1];
  assert(backgroundPopupRef, "Background workspace popup snapshot missed its action");
  await callBrowserTool(backgroundClient, "browser_click", {
    browserId: backgroundPopup.browserId,
    ref: backgroundPopupRef,
  });
  assert(
    await page.evaluate(() => document.activeElement?.id === "cross-session-focus-sentinel"),
    "Popup input from another workspace stole the user's host input focus",
  );
  await callBrowserTool(backgroundClient, "browser_close_tab", {
    browserId: backgroundPopup.browserId,
  });
  await callBrowserTool(backgroundClient, "browser_close_tab", {
    browserId: backgroundCreated.browserId,
  });
  await page.evaluate(() => document.querySelector("#cross-session-focus-sentinel")?.remove());

  const popupReport = await runPopupRegression({
    page,
    client,
    browserId,
    originalDeck,
    serverId,
    targetUrl,
    artifactDir,
  });

  const deviceSizeMenuPainted = await selectDeviceSize(page, "iPhone SE · 375×667");
  assert(deviceSizeMenuPainted, "Device size menu did not paint above the browser surface");
  recordViewportMismatch(
    failures,
    "device size menu paints and receives input above the browser surface",
    await readViewport(client, browserId),
    { width: 375, height: 667 },
  );

  await callBrowserTool(client, "browser_wait", {
    browserId,
    text: "Bridge target",
    timeoutMs: 5_000,
  });
  const requestedViewport = { width: 640, height: 480 };
  await callBrowserTool(client, "browser_resize", { browserId, ...requestedViewport });
  recordViewportMismatch(
    failures,
    "browser_resize updates the visible shared viewport",
    await readViewport(client, browserId),
    requestedViewport,
  );

  const oversizedViewport = { width: 2560, height: 1440 };
  await callBrowserTool(client, "browser_resize", { browserId, ...oversizedViewport });
  recordViewportMismatch(
    failures,
    "oversized preset preserves the requested guest viewport",
    await readViewport(client, browserId),
    oversizedViewport,
  );
  await page.waitForFunction(
    ({ id, width, height }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview instanceof HTMLElement &&
        Math.round(webview.getBoundingClientRect().width) === width &&
        Math.round(webview.getBoundingClientRect().height) === height
      );
    },
    { id: browserId, ...oversizedViewport },
    { timeout: timeoutMs },
  );
  const presentation = await readPresentation(page, browserId);
  assert(presentation, "Oversized browser presentation geometry was unavailable");
  if (
    presentation.surface.left < presentation.clip.left ||
    presentation.surface.top < presentation.clip.top ||
    presentation.surface.right > presentation.clip.right ||
    presentation.surface.bottom > presentation.clip.bottom
  ) {
    failures.push(
      `oversized browser surface stays inside its pane: ${JSON.stringify(presentation)}`,
    );
  }
  if (presentation.capturesOutsideInput) {
    failures.push("oversized browser surface captures input outside its pane");
  }
  await callBrowserTool(client, "browser_resize", { browserId, ...oversizedViewport });
  const repeatedResizePresentation = await readPresentation(page, browserId);
  assert(repeatedResizePresentation, "Repeated resize presentation geometry was unavailable");
  if (
    repeatedResizePresentation.webview.left !== presentation.webview.left ||
    repeatedResizePresentation.webview.top !== presentation.webview.top
  ) {
    failures.push(
      `repeating an oversized resize preserves the guest offset: before ${JSON.stringify(presentation.webview)}, after ${JSON.stringify(repeatedResizePresentation.webview)}`,
    );
  }
  await callBrowserTool(client, "browser_resize", { browserId, ...requestedViewport });

  await selectDeviceSize(page, "Responsive");
  const responsiveViewport = await readViewport(client, browserId);

  await originalDeck.getByTestId(`workspace-tab-agent_${callerAgentId}`).click();
  await page.waitForTimeout(500);
  try {
    await callBrowserTool(client, "browser_screenshot", { browserId });
  } catch (error) {
    failures.push(`inactive browser remains captureable: ${String(error)}`);
  }
  recordViewportMismatch(
    failures,
    "inactive browser preserves the shared viewport",
    await readViewport(client, browserId),
    responsiveViewport,
  );
  const focusContinuitySentinel = "preserve-browser-document-across-focus";
  await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: `() => {
      globalThis.__paseoFocusContinuity = ${JSON.stringify(focusContinuitySentinel)};
      globalThis.__paseoViewportTransitions = [{ width: innerWidth, height: innerHeight }];
      addEventListener('resize', () => {
        globalThis.__paseoViewportTransitions.push({ width: innerWidth, height: innerHeight });
      });
      return globalThis.__paseoFocusContinuity;
    }`,
  });
  await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!webview) throw new Error(`Browser webview ${id} was unavailable`);
    const events = [];
    globalThis.__paseoBrowserReactivationEvents = events;
    for (const name of [
      "did-start-loading",
      "did-navigate-in-page",
      "load-commit",
      "did-stop-loading",
    ]) {
      webview.addEventListener(name, (event) => {
        events.push({
          name,
          url: event.url ?? null,
          isMainFrame: event.isMainFrame ?? null,
        });
      });
    }
  }, browserId);

  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
  await page.waitForFunction(
    ({ id, webContentsId }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview?.parentElement?.getAttribute("data-paseo-browser-surface") === id &&
        webview.parentElement.style.pointerEvents === "auto" &&
        webview.getWebContentsId() === webContentsId
      );
    },
    { id: browserId, webContentsId: firstGuest.webContentsId },
    { timeout: timeoutMs },
  );
  await page.waitForTimeout(1_500);
  const reactivationEvents = await page.evaluate(
    () => globalThis.__paseoBrowserReactivationEvents ?? [],
  );
  const unexpectedReactivationCommits = reactivationEvents.filter(
    (event) => event.name === "did-navigate-in-page" || event.name === "load-commit",
  );
  assert(
    unexpectedReactivationCommits.length === 0,
    `responsive browser reactivation committed the current document: ${JSON.stringify(unexpectedReactivationCommits)}`,
  );
  const viewportTransitionsResult = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => globalThis.__paseoViewportTransitions ?? []",
  });
  const viewportTransitions = JSON.parse(viewportTransitionsResult.resultJson);
  const collapsedViewport = viewportTransitions.find(
    (viewport) => viewport.width <= 1 || viewport.height <= 1,
  );
  assert(
    collapsedViewport === undefined,
    `responsive browser reactivation collapsed the guest viewport: ${JSON.stringify(viewportTransitions)}`,
  );
  const continuityResult = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => globalThis.__paseoFocusContinuity ?? null",
  });
  const continuityValue = JSON.parse(continuityResult.resultJson);
  if (continuityValue !== focusContinuitySentinel) {
    failures.push(
      `focusing the browser tab preserves the current document: expected ${JSON.stringify(focusContinuitySentinel)}, received ${JSON.stringify(continuityValue)}`,
    );
  }

  for (const workspaceId of workspaceIds.slice(1)) {
    await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`).click();
    await page
      .getByTestId(`workspace-deck-entry-${serverId}:${workspaceId}`)
      .waitFor({ state: "visible" });
  }

  await page.waitForFunction(
    ({ id, previousWebContentsId }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview?.parentElement?.getAttribute("data-paseo-browser-surface") === id &&
        webview.parentElement.style.width === "1px" &&
        typeof webview.getWebContentsId === "function" &&
        webview.getWebContentsId() === previousWebContentsId
      );
    },
    { id: browserId, previousWebContentsId: firstGuest.webContentsId },
    { timeout: timeoutMs },
  );
  const parkedGuest = await readGuest(page, browserId);
  assert(parkedGuest, "Browser guest was not parked after workspace eviction");

  const listed = await callBrowserTool(client, "browser_list_tabs");
  assert(
    listed.tabs.some((tab) => tab.browserId === browserId),
    "browser_list_tabs lost the original tab after workspace eviction",
  );

  const snapshot = await callBrowserTool(client, "browser_snapshot", { browserId });
  const ref = snapshot.snapshot.match(/button "Bridge target" \[ref=(@e\d+)\]/)?.[1];
  assert(ref, `browser_snapshot did not expose the target button: ${snapshot.snapshot}`);

  const clicked = await callBrowserTool(client, "browser_click", { browserId, ref });
  assert(
    clicked.browserId === browserId && clicked.ref === ref,
    "browser_click targeted another tab",
  );
  await callBrowserTool(client, "browser_wait", {
    browserId,
    text: "Clicked",
    timeoutMs: 5_000,
  });

  await originalWorkspaceRow.click();
  await originalDeck.getByTestId(`workspace-tab-browser_${browserId}`).click();
  await page.waitForFunction(
    ({ id, webContentsId }) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return (
        webview?.parentElement?.getAttribute("data-paseo-browser-surface") === id &&
        webview.parentElement.style.pointerEvents === "auto" &&
        webview.getWebContentsId() === webContentsId
      );
    },
    { id: browserId, webContentsId: firstGuest.webContentsId },
    { timeout: timeoutMs },
  );
  recordViewportMismatch(
    failures,
    "browser viewport survives workspace eviction and reattachment",
    await readViewport(client, browserId),
    responsiveViewport,
  );

  const annotateButton = originalDeck.getByRole("button", { name: "Annotate element" });
  await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) throw new Error(`Browser webview ${id} was unavailable`);
    globalThis.__paseoOriginalIsLoadingDescriptor = Object.getOwnPropertyDescriptor(
      webview,
      "isLoading",
    );
    Object.defineProperty(webview, "isLoading", {
      configurable: true,
      value: () => true,
    });
  }, browserId);
  await annotateButton.click();
  await page.waitForTimeout(100);
  assert(
    !(await originalDeck.getByRole("button", { name: "Cancel element selector" }).isVisible()),
    "Element selector started while the guest reported a genuine load",
  );
  const selectorDuringLoad = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => Boolean(globalThis.__paseoSelector)",
  });
  assert(
    JSON.parse(selectorDuringLoad.resultJson) === false,
    "Selector injected while the guest reported a genuine load",
  );
  assert(
    await page.getByText("Wait for the page to finish loading").isVisible(),
    "Element selector loading failure was not visible",
  );
  await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) throw new Error(`Browser webview ${id} was unavailable`);
    const descriptor = globalThis.__paseoOriginalIsLoadingDescriptor;
    if (descriptor) Object.defineProperty(webview, "isLoading", descriptor);
    else delete webview.isLoading;
    delete globalThis.__paseoOriginalIsLoadingDescriptor;
  }, browserId);

  const readyStateResult = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => document.readyState",
  });
  assert(
    JSON.parse(readyStateResult.resultJson) === "complete",
    "Local browser document did not finish loading",
  );
  // Reproduce the report's mismatch: the guest is complete, but the pane's
  // last loading signal says it is not ready.
  await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!(webview instanceof HTMLElement)) {
      throw new Error(`Browser webview ${id} was unavailable`);
    }
    webview.dispatchEvent(new Event("did-start-loading"));
  }, browserId);

  await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: `() => {
      globalThis.__paseoSelectorTargetActivated = false;
      globalThis.__paseoSelectorCaptureActivated = false;
      const target = document.querySelector("#bridge-target");
      target.addEventListener("click", () => {
        globalThis.__paseoSelectorTargetActivated = true;
      });
      document.addEventListener("click", () => {
        globalThis.__paseoSelectorCaptureActivated = true;
      }, true);
      const overlay = document.createElement("div");
      overlay.id = "selector-pointer-events-overlay";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.pointerEvents = "none";
      document.body.appendChild(overlay);
      return true;
    }`,
  });

  await annotateButton.click();
  assert(
    await waitForGuestSelector(client, browserId),
    "Loaded local browser did not become ready for element annotation",
  );
  await page.screenshot({ path: path.join(artifactDir, "local-page-annotate-selector.png") });
  await clickGuestElement(page, client, browserId, "#bridge-target");
  const annotationInput = page.getByRole("textbox", {
    name: "Message to the agent about this element…",
  });
  await annotationInput.waitFor({ state: "attached", timeout: 5_000 });
  const annotationPresentation = await annotationInput.evaluate((input) => {
    const rect = input.getBoundingClientRect();
    const centerTarget = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        getComputedStyle(input).visibility !== "hidden",
      targetTag: centerTarget instanceof Element ? centerTarget.tagName : null,
      targetInsideInput: input === centerTarget || input.contains(centerTarget),
    };
  });
  assert(
    annotationPresentation.visible,
    `Browser annotation input has no visible bounds: ${JSON.stringify(annotationPresentation)}`,
  );
  assert(
    annotationPresentation.targetInsideInput,
    `Browser surface covers the annotation input: ${JSON.stringify(annotationPresentation)}`,
  );
  const selectorSideEffects = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: `() => ({
      target: Boolean(globalThis.__paseoSelectorTargetActivated),
      capture: Boolean(globalThis.__paseoSelectorCaptureActivated)
    })`,
  });
  assert(
    selectorSideEffects.resultJson === '{"target":false,"capture":false}',
    `Element selector leaked page actions: ${selectorSideEffects.resultJson}`,
  );
  await annotationInput.fill("Visible annotation");
  const attachButton = page.getByRole("button", { name: "Attach" });
  await attachButton.waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForFunction(
    (button) => button?.getAttribute("aria-busy") !== "true" && !button?.hasAttribute("disabled"),
    await attachButton.elementHandle(),
    { timeout: 5_000 },
  );
  await attachButton.click();
  await annotationInput.waitFor({ state: "detached", timeout: 5_000 });

  await delay(10_000);
  const screenshotButton = originalDeck.getByRole("button", { name: "Screenshot element" });
  await screenshotButton.click();
  assert(
    await waitForGuestSelector(client, browserId),
    "Loaded local browser did not become ready for element screenshots",
  );
  await delay(20_500);
  const selectorAfterPriorTimeout = await callBrowserTool(client, "browser_evaluate", {
    browserId,
    function: "() => Boolean(globalThis.__paseoSelector)",
  });
  if (JSON.parse(selectorAfterPriorTimeout.resultJson) !== true) {
    failures.push("a previous selector timeout does not destroy the current selector session");
  }
  await page.screenshot({ path: path.join(artifactDir, "local-page-screenshot-selector.png") });
  await originalDeck.getByRole("button", { name: "Cancel element selector" }).click();

  if (failures.length > 0) {
    throw new Error(`Browser viewport regressions:\n- ${failures.join("\n- ")}`);
  }

  return {
    browserId,
    originalWebContentsId: firstGuest.webContentsId,
    finalWebContentsId: parkedGuest.webContentsId,
    viewport: "passed",
    guestFocus: "passed",
    crossSessionFocus: "passed",
    overlayPlane: "passed",
    inactiveCapture: "passed",
    list: "passed",
    snapshot: "passed",
    click: "passed",
    localPageSelectors: "passed",
    popupTargets: popupReport,
  };
}

async function main() {
  const artifactDir =
    process.env.PASEO_DESKTOP_BROWSER_E2E_ARTIFACT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "paseo-desktop-browser-e2e-artifacts-"));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-desktop-browser-e2e-"));
  fs.mkdirSync(artifactDir, { recursive: true });
  const paseoHome = path.join(runtimeDir, "paseo-home");
  const userData = path.join(runtimeDir, "electron-user-data");
  const workspaceRoot = path.join(runtimeDir, "workspaces");
  fs.mkdirSync(paseoHome, { recursive: true });

  const [daemonPort, expoPort, cdpPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const listen = `127.0.0.1:${daemonPort}`;
  seedPaseoHome(paseoHome, listen, workspaceRoot);
  const target = await startTargetPage();
  const children = [];
  let browser = null;
  let client = null;
  let backgroundClient = null;

  try {
    const commonEnv = {
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: listen,
      PASEO_DAEMON_ENDPOINT: `localhost:${daemonPort}`,
      PASEO_CORS_ORIGINS: "*",
      PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
      PASEO_DICTATION_ENABLED: "0",
      PASEO_VOICE_MODE_ENABLED: "0",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    const daemon = spawnLogged(
      "daemon",
      process.execPath,
      ["--import", "tsx", path.join(rootDir, "packages/server/scripts/dev-runner.ts")],
      { cwd: rootDir, env: { ...commonEnv, PASEO_NODE_ENV: "development" } },
      artifactDir,
    );
    children.push(daemon.child);
    await waitForPort(daemonPort, "daemon", daemon);

    const desktopArgs = [
      process.execPath,
      devRunner,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ];
    const desktopCommand = process.platform === "linux" ? "xvfb-run" : desktopArgs.shift();
    const desktopCommandArgs =
      process.platform === "linux"
        ? ["-a", "--server-args=-screen 0 1280x800x24", ...desktopArgs]
        : desktopArgs;
    const desktop = spawnLogged(
      "desktop",
      desktopCommand,
      desktopCommandArgs,
      {
        cwd: rootDir,
        env: {
          ...commonEnv,
          EXPO_PORT: String(expoPort),
          EXPO_DEV_URL: `http://localhost:${expoPort}`,
          PASEO_ELECTRON_REMOTE_DEBUGGING_PORT: String(cdpPort),
          PASEO_ELECTRON_USER_DATA_DIR: userData,
          PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
        },
      },
      artifactDir,
    );
    children.push(desktop.child);
    await waitForPort(cdpPort, "Electron CDP", desktop);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    for (const context of browser.contexts()) {
      const observeElectronHandledDialog = (targetPage) => {
        // Electron's per-target CDP monitor owns popup dialog policy. Registering a
        // Playwright observer prevents its default auto-dismiss session from racing that owner.
        targetPage.on("dialog", () => {});
      };
      context.on("page", observeElectronHandledDialog);
      for (const targetPage of context.pages()) observeElectronHandledDialog(targetPage);
    }
    const page = await waitForAppPage(browser, expoPort);
    const status = await waitForDesktopStatus(page);

    await runAppearanceFontSizeRegression(page);

    const callerAgentId = await createCallerAgent(daemonPort);
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `http://127.0.0.1:${daemonPort}/mcp/agents?callerAgentId=${encodeURIComponent(callerAgentId)}`,
      ),
    );
    client = await experimental_createMCPClient({ transport });
    const backgroundCallerAgentId = await createCallerAgent(daemonPort, workspaceIds[1]);
    const backgroundTransport = new StreamableHTTPClientTransport(
      new URL(
        `http://127.0.0.1:${daemonPort}/mcp/agents?callerAgentId=${encodeURIComponent(backgroundCallerAgentId)}`,
      ),
    );
    backgroundClient = await experimental_createMCPClient({ transport: backgroundTransport });
    const report = await runRegression({
      page,
      client,
      backgroundClient,
      serverId: status.serverId,
      targetUrl: target.url,
      callerAgentId,
      artifactDir,
    });
    writeJson(path.join(artifactDir, "result.json"), report);
    console.log(
      `Browser desktop browser E2E passed: WebContents ${report.originalWebContentsId} remained ${report.finalWebContentsId}; viewport, inactive capture, cross-session focus continuity, list, snapshot, click, local-page selectors passed.`,
    );
  } catch (error) {
    console.error(`Browser desktop browser E2E failed. Artifacts: ${artifactDir}`);
    console.error(error);
    throw error;
  } finally {
    await backgroundClient?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    for (const child of children.toReversed()) stopProcess(child);
    await closeServer(target.server);
    await delay(1_000);
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`Failed to remove isolated E2E state ${runtimeDir}`, error);
    }
  }
}

await main();
