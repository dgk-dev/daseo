/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import { i18n as testI18n } from "@/i18n/i18next";
import { formatMessageTimestamp } from "@/utils/time";
import { AssistantResponseBlock, AssistantTurnFooter, UserMessage } from "./message";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
});

// The shared unistyles stub carries only a fixture subset of the theme; message.tsx's import
// graph styles code blocks, tool rows, and menus from the full one.
vi.mock("react-native-unistyles", async () => {
  const { darkDaseoTheme } = await import("@/styles/theme");
  return {
    StyleSheet: {
      create: (styles: unknown) => (typeof styles === "function" ? styles(darkDaseoTheme) : styles),
    },
    withUnistyles: (component: unknown) => component,
    useUnistyles: () => ({ theme: darkDaseoTheme, rt: { breakpoint: "md" } }),
    UnistylesRuntime: { themeName: "dark" },
  };
});

// Its source ships untranspiled JSX; these tests never render markdown.
vi.mock("react-native-markdown-display", () => ({
  default: () => null,
  MarkdownIt: () => ({}),
  renderRules: {},
  stringToTokens: () => [],
  tokensToAST: () => [],
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: async () => true,
}));

vi.mock("@/components/rewind/use-rewind-agent-mutation", () => ({
  useRewindAgentMutation: () => ({ rewindAgent: async () => undefined, isPending: false }),
}));

// The menus and the rest of message.tsx's native-heavy leaves (bottom sheet, gesture handler,
// markdown, file links) are outside these rows; the menus keep their trigger test IDs.
vi.mock("@/components/rewind/rewind-menu", () => ({
  RewindMenu: () =>
    React.createElement("button", { type: "button", "data-testid": "rewind-menu-trigger" }),
}));

vi.mock("@/components/assistant-fork-menu", () => ({
  AssistantForkMenu: () =>
    React.createElement("button", { type: "button", "data-testid": "assistant-fork-menu-trigger" }),
}));

vi.mock("@/components/attachment-lightbox", () => ({ AttachmentLightbox: () => null }));
vi.mock("@/components/tool-call-sheet", () => ({ useToolCallSheet: () => ({}) }));
vi.mock("@/components/tool-call-details", () => ({ ToolCallDetailsContent: () => null }));
vi.mock("@/components/plan-card", () => ({ PlanCard: () => null }));
vi.mock("@/components/markdown/fence", () => ({ MarkdownFenceBlock: () => null }));
vi.mock("@/utils/rich-clipboard-default-environment", () => ({
  getDefaultMarkdownClipboardEnvironment: () => ({}),
}));
vi.mock("@/assistant-file-links", () => ({
  AssistantInlineCodePathLink: () => null,
  AssistantMarkdownCodeLink: () => null,
  AssistantMarkdownLink: () => null,
  useAssistantFileLinkActions: () => ({}),
  useAssistantLinkPress: () => () => false,
}));

// Load translations so controls expose their real accessible names.
void testI18n;

/**
 * Daseo delta 32: the rows under a prompt and under an answer are on screen without the pointer
 * ever entering them, on every platform. Visibility is the opacity and pointer-events of every
 * element between the control and the message, since the rows used to be hidden by an opacity-0
 * ancestor rather than by unmounting.
 */

const mounted: { root: Root; container: HTMLDivElement }[] = [];

beforeEach(() => {
  // App sources compile against the classic JSX runtime, which expects React on the global.
  vi.stubGlobal("React", React);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

function expectShownWithin(element: Element, boundary: Element): void {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const label =
      node.getAttribute("data-testid") ?? node.getAttribute("aria-label") ?? node.tagName;
    expect(style.opacity === "" || style.opacity === "1", `${label} opacity`).toBe(true);
    expect(style.pointerEvents, `${label} pointer-events`).not.toBe("none");
    if (node === boundary) return;
  }
  throw new Error("element is not inside the boundary");
}

const sentAt = new Date("2026-10-04T10:15:00.000Z");
const rewindCapabilities: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
};
const getAnswer = () => "answer";
const forkTurn = () => undefined;

function renderUserMessage(isPending = false): HTMLDivElement {
  return mount(
    <UserMessage
      serverId="server-1"
      agentId="agent-1"
      messageId="message-1"
      message="Ship the release"
      timestamp={sentAt.getTime()}
      capabilities={rewindCapabilities}
      client={null}
      isPending={isPending}
    />,
  );
}

describe("user prompt trailing row", () => {
  it("shows time, rewind, and copy without hover", () => {
    const view = within(renderUserMessage());
    const message = view.getByTestId("user-message");

    expect(view.getByTestId("user-message-timestamp").textContent).toBe(
      formatMessageTimestamp(sentAt),
    );
    expectShownWithin(view.getByTestId("user-message-timestamp"), message);
    expectShownWithin(view.getByTestId("rewind-menu-trigger"), message);
    expectShownWithin(view.getByRole("button", { name: "Copy message" }), message);
  });

  it("keeps the row hidden until the prompt is delivered", () => {
    const row = within(renderUserMessage(true)).getByTestId("user-message-trailing-row");

    expect(getComputedStyle(row).opacity).toBe("0");
    expect(getComputedStyle(row).pointerEvents).toBe("none");
  });
});

describe("assistant completion row", () => {
  const completedAt = new Date("2026-10-04T10:16:00.000Z");

  it("shows duration and completion time together, with copy and fork, without hover", () => {
    const view = within(
      mount(
        <div data-testid="turn">
          <AssistantTurnFooter
            getContent={getAnswer}
            completedAt={completedAt}
            durationMs={12_000}
            onFork={forkTurn}
          />
        </div>,
      ),
    );
    const turn = view.getByTestId("turn");
    const label = view.getByTestId("assistant-turn-footer-label");

    expect(label.textContent).toBe(`Worked for 12s · ${formatMessageTimestamp(completedAt)}`);
    expectShownWithin(label, turn);
    expectShownWithin(view.getByRole("button", { name: "Copy turn" }), turn);
    expectShownWithin(view.getByTestId("assistant-fork-menu-trigger"), turn);
  });

  it("shows the end time alone when the turn has no duration", () => {
    const view = within(
      mount(<AssistantTurnFooter getContent={getAnswer} completedAt={completedAt} />),
    );

    expect(view.getByTestId("assistant-turn-footer-label").textContent).toBe(
      formatMessageTimestamp(completedAt),
    );
  });

  it("closes a response another follows with its copy and time on screen", () => {
    const arrivedAt = new Date("2026-10-04T10:17:00.000Z");
    const view = within(
      mount(
        <div data-testid="response">
          <AssistantResponseBlock content="first answer" timestamp={arrivedAt.getTime()}>
            <span>first answer</span>
          </AssistantResponseBlock>
        </div>,
      ),
    );
    const response = view.getByTestId("response");

    expect(view.getByTestId("assistant-response-timestamp").textContent).toBe(
      formatMessageTimestamp(arrivedAt),
    );
    expectShownWithin(view.getByTestId("assistant-response-timestamp"), response);
    expectShownWithin(view.getByRole("button", { name: "Copy message" }), response);
  });
});
