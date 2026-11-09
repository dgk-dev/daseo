/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import type { InlinePathTarget } from "./parse";
import { AssistantFileLinkResolverProvider } from "./provider";
import type { DirectorySuggestionResult, ResolvePath } from "./resolver";
import { useFileLink } from "./use-file-link";
import type { OpenFileDisposition } from "@/workspace/file-open";

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

const desktopMock = vi.hoisted(() => ({
  isLocalDaemon: false,
  openLocalPath: null as
    | null
    | ((
        path: string,
        options?: { reveal?: boolean },
      ) => Promise<"opened" | "revealed" | "not-handled">),
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useIsLocalDaemon: () => desktopMock.isLocalDaemon,
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () =>
    desktopMock.openLocalPath ? { opener: { openLocalPath: desktopMock.openLocalPath } } : null,
}));

const SOURCE = {
  href: "http://dumm.md",
  text: "dumm.md",
  markup: "linkify",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

interface OpenedFile {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
}

interface TestClient {
  getDirectorySuggestions: (input: {
    query: string;
    cwd: string;
    includeFiles: true;
    includeDirectories: false;
    matchMode: "suffix";
    limit: number;
  }) => Promise<DirectorySuggestionResult>;
  resolvePath?: ResolvePath;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createToast(): ToastApi {
  return {
    show: vi.fn<ToastApi["show"]>(),
    copied: vi.fn<ToastApi["copied"]>(),
    error: vi.fn<ToastApi["error"]>(),
  };
}

function createWrapper(input: {
  client: TestClient;
  openedFiles: OpenedFile[];
  toast?: ToastApi;
  openFileExternally?: (target: InlinePathTarget) => Promise<boolean>;
  supportsPathResolve?: boolean;
}) {
  const queryClient = createQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    const openWorkspaceFile = useCallback(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        input.openedFiles.push({ target, disposition });
      },
      [],
    );

    return (
      <QueryClientProvider client={queryClient}>
        <AssistantFileLinkResolverProvider
          client={input.client}
          serverId="server-1"
          workspaceRoot="/Users/test/project"
          supportsPathResolve={input.supportsPathResolve}
          onOpenWorkspaceFile={openWorkspaceFile}
          openFileExternally={input.openFileExternally}
          toast={input.toast}
        >
          {children}
        </AssistantFileLinkResolverProvider>
      </QueryClientProvider>
    );
  };
}

describe("useFileLink", () => {
  it("returns the same object across no-op parent rerenders", () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
    const queryClient = createQueryClient();
    const Provider = AssistantFileLinkResolverProvider as React.ComponentType<
      Omit<React.ComponentProps<typeof AssistantFileLinkResolverProvider>, "children"> & {
        children?: ReactNode;
      }
    >;

    function ChurningProviderWrapper({ children }: { children: ReactNode }) {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Provider,
          {
            client: { getDirectorySuggestions },
            serverId: "server-1",
            workspaceRoot: "/Users/test/project",
            onOpenWorkspaceFile: () => {},
            toast: createToast(),
          },
          children,
        ),
      );
    }

    const { result, rerender } = renderHook(() => useFileLink({ ...SOURCE }), {
      wrapper: ChurningProviderWrapper,
    });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.onHoverIn).toBe(first.onHoverIn);
    expect(result.current.onPress).toBe(first.onPress);
    expect(result.current.onAuxPress).toBe(first.onAuxPress);
    expect(result.current.open).toBe(first.open);
  });

  it("does not cache unresolved lookups forever", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockResolvedValueOnce(resolvedSuggestions([]))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const toast = createToast();
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
        toast,
      }),
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(toast.show).toHaveBeenCalledWith("No file found for dumm.md", {
        variant: "error",
        testID: "assistant-file-link-not-found-toast",
      });
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toEqual([
        {
          target: {
            raw: "dumm.md",
            path: "/Users/test/project/docs/dumm.md",
            lineStart: undefined,
            lineEnd: undefined,
          },
          disposition: "main",
        },
      ]);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("click retries after hover prefetch fails", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("opens the paths agents actually write: spaces, home-relative, documents, and gitignored dirs", async () => {
    const searches: string[] = [];
    const getDirectorySuggestions = vi.fn(async (input: { query: string }) => {
      searches.push(input.query);
      // Only the spreadsheet is indexed; the other relative paths live in
      // gitignored or hidden folders the suffix search never returns.
      return resolvedSuggestions(
        input.query === "docs/report.xlsx" ? [{ path: "docs/report.xlsx", kind: "file" }] : [],
      );
    });
    const openedFiles: OpenedFile[] = [];
    const toast = createToast();
    const wrapper = createWrapper({ client: { getDirectorySuggestions }, openedFiles, toast });
    const inlineCode = (text: string) => ({ href: text, text, sourceType: "inline-code" as const });

    const cases = [
      inlineCode("docs/최종 보고서.md"),
      inlineCode("~/.pi/agent/plans/-Users-ddgk/2026-09-17-plan.md"),
      inlineCode("docs/report.xlsx"),
      inlineCode(".secrets/neon.env"),
      inlineCode("/tmp/회의 녹취록.txt:12"),
    ];
    for (const source of cases) {
      const { result } = renderHook(() => useFileLink(source), { wrapper });
      act(() => {
        result.current.onPress();
      });
    }
    await waitFor(() => {
      expect(openedFiles).toHaveLength(cases.length);
    });

    // Direct targets open synchronously and searched ones after the daemon
    // answers, so compare as a set.
    expect(openedFiles.map((entry) => entry.target.path).sort()).toEqual(
      [
        "/Users/test/project/docs/최종 보고서.md",
        "~/.pi/agent/plans/-Users-ddgk/2026-09-17-plan.md",
        "/Users/test/project/docs/report.xlsx",
        "/Users/test/project/.secrets/neon.env",
        "/tmp/회의 녹취록.txt",
      ].sort(),
    );
    expect(
      openedFiles.find((entry) => entry.target.path === "/tmp/회의 녹취록.txt")?.target.lineStart,
    ).toBe(12);
    // Home-relative and absolute tokens never hit the daemon search; relative
    // ones do, and a miss falls back to the direct path instead of a toast.
    expect(searches).toEqual(["docs/최종 보고서.md", "docs/report.xlsx", ".secrets/neon.env"]);
    expect(toast.show).not.toHaveBeenCalled();

    // A bare word with an unknown extension and a command line are still not links.
    for (const text of ["output.bin", "git add src/a.ts src/b.ts"]) {
      const { result } = renderHook(() => useFileLink(inlineCode(text)), { wrapper });
      expect(result.current.target).toBeNull();
      act(() => {
        result.current.onPress();
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openedFiles).toHaveLength(cases.length);
  });

  it("dedupes two links pointing at the same source", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(
      () => ({
        first: useFileLink(SOURCE),
        second: useFileLink(SOURCE),
      }),
      {
        wrapper: createWrapper({
          client: { getDirectorySuggestions },
          openedFiles,
        }),
      },
    );

    act(() => {
      result.current.first.onHoverIn();
      result.current.second.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    await waitFor(() => {
      expect(result.current.first.target?.path).toBe("/Users/test/project/docs/dumm.md");
      expect(result.current.second.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });
  });

  it("prefetches only for a link the pointer rests on", async () => {
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]),
    );
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({ client: { getDirectorySuggestions }, openedFiles: [] }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    act(() => {
      result.current.onHoverOut();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(getDirectorySuggestions).not.toHaveBeenCalled();

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
  });

  it("does not start a hover prefetch while another lookup is running", async () => {
    const running = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => running.promise);
    const openedFiles: OpenedFile[] = [];
    const wrapper = createWrapper({ client: { getDirectorySuggestions }, openedFiles });
    const first = renderHook(() => useFileLink(SOURCE), { wrapper });
    const second = renderHook(
      () => useFileLink({ href: "http://other.md", text: "other.md", markup: "linkify" }),
      { wrapper },
    );

    act(() => {
      first.result.current.onPress();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    act(() => {
      second.result.current.onHoverIn();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);

    running.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
  });

  it("hover then click uses the prefetched result", async () => {
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]),
    );
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(result.current.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
  });

  it("does not open a stale result after the workspace changes", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const queryClient = createQueryClient();

    function Wrapper({ children }: { children: ReactNode }) {
      const [workspaceRoot, setWorkspaceRoot] = useState("/Users/test/project");
      const client = useMemo(() => ({ getDirectorySuggestions }), []);
      const openWorkspaceFile = useCallback(
        (target: InlinePathTarget, disposition: OpenFileDisposition) => {
          openedFiles.push({ target, disposition });
        },
        [],
      );
      return (
        <QueryClientProvider client={queryClient}>
          <AssistantFileLinkResolverProvider
            client={client}
            serverId="server-1"
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={openWorkspaceFile}
          >
            <WorkspaceSwitchContext.Provider value={setWorkspaceRoot}>
              {children}
            </WorkspaceSwitchContext.Provider>
          </AssistantFileLinkResolverProvider>
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(
      () => ({
        link: useFileLink(SOURCE),
        setWorkspaceRoot: React.useContext(WorkspaceSwitchContext),
      }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.link.onPress();
    });
    act(() => {
      result.current.setWorkspaceRoot("/Users/test/other");
    });
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));

    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    expect(openedFiles).toEqual([]);
  });
});

const WorkspaceSwitchContext = React.createContext<(workspaceRoot: string) => void>(() => {});

describe("useFileLink dispatch (Daseo delta 75)", () => {
  const inlineCode = (text: string) => ({ href: text, text, sourceType: "inline-code" as const });

  it("opens text and images in the phone's file pane and hands everything else to another app", async () => {
    const openedFiles: OpenedFile[] = [];
    const externallyOpened: string[] = [];
    const openFileExternally = vi.fn(async (target: InlinePathTarget) => {
      externallyOpened.push(target.path);
      return true;
    });
    const wrapper = createWrapper({
      client: { getDirectorySuggestions: vi.fn(async () => resolvedSuggestions([])) },
      openedFiles,
      openFileExternally,
    });

    const inApp = [
      "/tmp/plan.md",
      "/tmp/page.html",
      "/tmp/data.csv",
      "/tmp/a.ts:12",
      "/tmp/shot.png",
    ];
    const external = ["/tmp/report.pdf", "/tmp/memo.docx", "/tmp/문서.hwp", "/tmp/clip.mp4"];
    for (const text of [...inApp, ...external]) {
      const { result } = renderHook(() => useFileLink(inlineCode(text)), { wrapper });
      act(() => {
        result.current.onPress();
      });
    }

    await waitFor(() => {
      expect(openedFiles).toHaveLength(inApp.length);
      expect(externallyOpened).toHaveLength(external.length);
    });
    expect(openedFiles.map((entry) => entry.target.path).sort()).toEqual(
      ["/tmp/plan.md", "/tmp/page.html", "/tmp/data.csv", "/tmp/a.ts", "/tmp/shot.png"].sort(),
    );
    expect(externallyOpened.sort()).toEqual([...external].sort());
  });

  it("keeps the file pane for an external kind the daemon cannot download (a folder, a missing file)", async () => {
    const openedFiles: OpenedFile[] = [];
    const wrapper = createWrapper({
      client: { getDirectorySuggestions: vi.fn(async () => resolvedSuggestions([])) },
      openedFiles,
      openFileExternally: vi.fn(async () => false),
    });
    const { result } = renderHook(() => useFileLink(inlineCode("/tmp/missing.pdf")), { wrapper });
    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(openedFiles[0]?.target.path).toBe("/tmp/missing.pdf");
  });

  it("asks the Mac opener to reveal a path with a line reference", async () => {
    const calls: Array<{ path: string; reveal: boolean | undefined }> = [];
    desktopMock.isLocalDaemon = true;
    desktopMock.openLocalPath = async (path, options) => {
      calls.push({ path, reveal: options?.reveal });
      return options?.reveal ? "revealed" : "opened";
    };
    try {
      const openedFiles: OpenedFile[] = [];
      const wrapper = createWrapper({
        client: { getDirectorySuggestions: vi.fn(async () => resolvedSuggestions([])) },
        openedFiles,
      });
      for (const text of ["/tmp/notes.md:12", "/tmp/report.pdf"]) {
        const { result } = renderHook(() => useFileLink(inlineCode(text)), { wrapper });
        act(() => {
          result.current.onPress();
        });
      }
      await waitFor(() => {
        expect(calls).toHaveLength(2);
      });
      expect(calls).toContainEqual({ path: "/tmp/notes.md", reveal: true });
      expect(calls).toContainEqual({ path: "/tmp/report.pdf", reveal: false });
      expect(openedFiles).toEqual([]);
    } finally {
      desktopMock.isLocalDaemon = false;
      desktopMock.openLocalPath = null;
    }
  });
});

describe("useFileLink path resolve (Daseo delta 90)", () => {
  const inlineCode = (text: string) => ({ href: text, text, sourceType: "inline-code" as const });
  const noSuggestions = vi.fn(async () => resolvedSuggestions([]));

  function setup(resolvePath: ResolvePath) {
    const openedFiles: OpenedFile[] = [];
    const toast = createToast();
    const wrapper = createWrapper({
      client: { getDirectorySuggestions: noSuggestions, resolvePath },
      openedFiles,
      toast,
      supportsPathResolve: true,
    });
    return { openedFiles, toast, wrapper };
  }

  it("opens the one file an elided path names", async () => {
    const resolvePath = vi.fn<ResolvePath>(async () => ({
      matches: [{ path: "/Users/test/.pi/research/report.md", kind: "file" }],
      complete: true,
      error: null,
    }));
    const { openedFiles, wrapper } = setup(resolvePath);
    const { result } = renderHook(() => useFileLink(inlineCode("…/research/report.md")), {
      wrapper,
    });

    act(() => {
      result.current.onPress();
    });

    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(openedFiles[0]?.target.path).toBe("/Users/test/.pi/research/report.md");
    expect(resolvePath).toHaveBeenCalledWith({
      cwd: "/Users/test/project",
      candidates: [],
      suffix: "research/report.md",
      searchRoots: ["/Users/test/project", "~"],
    });
  });

  it("shows a toast instead of a pane for a missing file or several matches", async () => {
    const outcomes: Array<Awaited<ReturnType<ResolvePath>>> = [
      { matches: [], complete: true, error: null },
      {
        matches: [
          { path: "/Users/test/project/a/route.ts", kind: "file" },
          { path: "/Users/test/project/b/route.ts", kind: "file" },
        ],
        complete: true,
        error: null,
      },
    ];
    const { openedFiles, toast, wrapper } = setup(async () => outcomes.shift()!);

    for (const text of ["/Users/test/project/missing.md", "…/route.ts"]) {
      const { result } = renderHook(() => useFileLink(inlineCode(text)), { wrapper });
      act(() => {
        result.current.onPress();
      });
    }

    await waitFor(() => {
      expect(toast.show).toHaveBeenCalledTimes(2);
    });
    expect(toast.show).toHaveBeenCalledWith("No file found for /Users/test/project/missing.md", {
      variant: "error",
      testID: "assistant-file-link-not-found-toast",
    });
    expect(toast.show).toHaveBeenCalledWith("Several files match …/route.ts, so none was opened", {
      variant: "error",
      testID: "assistant-file-link-not-found-toast",
    });
    expect(openedFiles).toEqual([]);
  });

  it("hands a folder to the workspace opener with a trailing slash, never to a download", async () => {
    const openFileExternally = vi.fn(async () => true);
    const openedFiles: OpenedFile[] = [];
    const wrapper = createWrapper({
      client: {
        getDirectorySuggestions: noSuggestions,
        resolvePath: async () => ({
          matches: [{ path: "/Users/test/project/docs/guides", kind: "directory" }],
          complete: true,
          error: null,
        }),
      },
      openedFiles,
      openFileExternally,
      supportsPathResolve: true,
    });
    const { result } = renderHook(() => useFileLink({ href: "docs/guides", text: "guides" }), {
      wrapper,
    });

    act(() => {
      result.current.onPress();
    });

    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(openedFiles[0]?.target.path).toBe("/Users/test/project/docs/guides/");
    expect(openFileExternally).not.toHaveBeenCalled();
  });
});
