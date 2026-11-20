/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Autocomplete,
  areAutocompleteRowPropsEqual,
  type AutocompleteOption,
  type AutocompleteRowProps,
} from "@/components/ui/autocomplete";

void testI18n;

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    borderWidth: { 1: 1 },
    borderRadius: { lg: 8 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { normal: "400" },
    shadow: { md: {} },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface1: "#111",
      surface2: "#222",
      borderAccent: "#444",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return {
    ...actual,
    Pressable: ({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) =>
      React.createElement("button", { type: "button", onClick: () => onPress?.() }, children),
  };
});

vi.mock("lucide-react-native", () => ({
  File: () => null,
  Folder: () => null,
}));

type SelectableOption = AutocompleteOption & { generation: number };

function commandOptions(generation: number): SelectableOption[] {
  return [
    { id: "alpha", label: "/alpha", description: "First", kind: "command", generation },
    { id: "beta", label: "/beta", description: "Second", kind: "command", generation },
  ];
}

const noopSelectIndex = () => {};
const noopRowLayout = () => {};

function rowProps(overrides: Partial<AutocompleteRowProps> = {}): AutocompleteRowProps {
  return {
    index: 0,
    option: { id: "alpha", label: "/alpha", description: "First", kind: "command" },
    isSelected: false,
    mutedColor: "#aaa",
    onSelectIndex: noopSelectIndex,
    onRowLayout: noopRowLayout,
    ...overrides,
  };
}

describe("areAutocompleteRowPropsEqual (delta 138)", () => {
  it("skips a row whose shown content is unchanged even when the option object is new", () => {
    const previous = rowProps();
    const next = rowProps({ option: { ...previous.option } });
    expect(areAutocompleteRowPropsEqual(previous, next)).toBe(true);
  });

  it("re-renders a row when its selection, position, or shown text changes", () => {
    const previous = rowProps();
    expect(areAutocompleteRowPropsEqual(previous, rowProps({ isSelected: true }))).toBe(false);
    expect(areAutocompleteRowPropsEqual(previous, rowProps({ index: 1 }))).toBe(false);
    expect(
      areAutocompleteRowPropsEqual(
        previous,
        rowProps({ option: { ...previous.option, description: "Changed" } }),
      ),
    ).toBe(false);
  });
});

describe("Autocomplete row selection (delta 138)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("selects the current option object after the options were rebuilt", () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <Autocomplete options={commandOptions(1)} selectedIndex={0} onSelect={onSelect} />,
      );
    });
    act(() => {
      root.render(
        <Autocomplete options={commandOptions(2)} selectedIndex={1} onSelect={onSelect} />,
      );
    });

    const row = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === "/betaSecond",
    );
    expect(row).toBeDefined();
    act(() => {
      fireEvent.click(row!);
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ id: "beta", generation: 2 });
  });
});
