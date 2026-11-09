import { describe, expect, it } from "vitest";
import {
  classifyForResolution,
  fetchDaemonResolution,
  getAssistantFileLinkToken,
  planAssistantFileLink,
  resolvePathThroughDaemon,
  type ResolvePath,
  UnresolvedFileLinkError,
  type AssistantFileLinkContext,
  type DirectorySuggestionEntry,
  type DirectorySuggestionResult,
  type GetDirectorySuggestions,
} from "./resolver";

const CONTEXT: AssistantFileLinkContext = {
  workspaceRoot: "/Users/test/project",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

function suggestionsFromMap(entriesByQuery: Record<string, DirectorySuggestionEntry[]>): {
  getDirectorySuggestions: GetDirectorySuggestions;
  searches: Array<{
    query: string;
    cwd: string;
    matchMode: "suffix";
    limit: number;
  }>;
} {
  const searches: Array<{
    query: string;
    cwd: string;
    matchMode: "suffix";
    limit: number;
  }> = [];
  const getDirectorySuggestions: GetDirectorySuggestions = async (input) => {
    searches.push({
      query: input.query,
      cwd: input.cwd,
      matchMode: input.matchMode,
      limit: input.limit,
    });
    return resolvedSuggestions(entriesByQuery[input.query] ?? []);
  };
  return { getDirectorySuggestions, searches };
}

const unavailableSuggestions: GetDirectorySuggestions = async () => {
  throw new Error("daemon unavailable");
};

describe("classifyForResolution", () => {
  it("returns the directFile target synchronously", () => {
    const result = classifyForResolution({ href: "src/components/message.tsx#L33" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "src/components/message.tsx#L33",
          path: "/Users/test/project/src/components/message.tsx",
          lineStart: 33,
          lineEnd: undefined,
        },
      },
    });
  });

  it("preserves line ranges on direct workspace files", () => {
    const result = classifyForResolution({ href: "src/components/message.tsx:33-40" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "src/components/message.tsx:33-40",
          path: "/Users/test/project/src/components/message.tsx",
          lineStart: 33,
          lineEnd: 40,
        },
      },
    });
  });

  it("flags basename inline-code as a daemon lookup keyed by suggestion query", () => {
    const result = classifyForResolution(
      { href: "file.ts:12", text: "file.ts:12", sourceType: "inline-code" },
      CONTEXT,
    );

    expect(result).toEqual({
      kind: "needsLookup",
      ambiguousQuery: "file.ts",
      token: "file.ts:12",
      target: {
        raw: "file.ts:12",
        path: "/Users/test/project/file.ts",
        lineStart: 12,
        lineEnd: undefined,
      },
    });
  });

  it("keeps explicit external URLs external", () => {
    const result = classifyForResolution({ href: "http://dumm.md", text: "dumm.md" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: { kind: "external", url: "http://dumm.md" },
    });
  });

  it("keeps absolute paths outside the workspace as direct file targets", () => {
    const result = classifyForResolution({ href: "/tmp/outside.txt" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "/tmp/outside.txt",
          path: "/tmp/outside.txt",
          lineStart: undefined,
          lineEnd: undefined,
        },
      },
    });
  });

  it("keeps tilde paths as direct file targets", () => {
    const result = classifyForResolution({ href: "~/.paseo/plans/file-preview.md" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "~/.paseo/plans/file-preview.md",
          path: "~/.paseo/plans/file-preview.md",
          lineStart: undefined,
          lineEnd: undefined,
        },
      },
    });
  });

  it("keeps auto-linkified normal domains external, over https when written without a scheme", () => {
    expect(
      classifyForResolution(
        { href: "http://google.com", text: "google.com", markup: "linkify" },
        CONTEXT,
      ),
    ).toEqual({
      kind: "resolved",
      value: { kind: "external", url: "https://google.com" },
    });
    expect(
      classifyForResolution(
        { href: "http://example.com/a", text: "http://example.com/a", markup: "linkify" },
        CONTEXT,
      ),
    ).toEqual({
      kind: "resolved",
      value: { kind: "external", url: "http://example.com/a" },
    });
  });

  it("returns ignored for non-file-looking content", () => {
    const result = classifyForResolution({ href: "" }, CONTEXT);

    expect(result).toEqual({ kind: "resolved", value: { kind: "ignored" } });
  });
});

describe("fetchDaemonResolution", () => {
  it("resolves daemon suggestions into workspace file targets", async () => {
    const { getDirectorySuggestions, searches } = suggestionsFromMap({
      "file.ts": [{ path: "packages/app/src/file.ts", kind: "file" }],
    });

    const result = await fetchDaemonResolution({
      ambiguousQuery: "file.ts",
      token: "file.ts:12",
      target: {
        raw: "file.ts:12",
        path: "/Users/test/project/file.ts",
        lineStart: 12,
        lineEnd: undefined,
      },
      workspaceRoot: "/Users/test/project",
      getDirectorySuggestions,
    });

    expect(searches).toEqual([
      {
        query: "file.ts",
        cwd: "/Users/test/project",
        matchMode: "suffix",
        limit: 1,
      },
    ]);
    expect(result).toEqual({
      raw: "file.ts:12",
      path: "/Users/test/project/packages/app/src/file.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("falls back to the direct target when a directory-qualified token has no search match", async () => {
    // Gitignored or hidden files never come back from the suffix search, but
    // `tmp/report.md` already says where the file is.
    const { getDirectorySuggestions } = suggestionsFromMap({});
    const target = {
      raw: "tmp/report.md",
      path: "/Users/test/project/tmp/report.md",
      lineStart: undefined,
      lineEnd: undefined,
    };

    await expect(
      fetchDaemonResolution({
        ambiguousQuery: "tmp/report.md",
        token: "tmp/report.md",
        target,
        workspaceRoot: "/Users/test/project",
        getDirectorySuggestions,
      }),
    ).resolves.toEqual(target);
  });

  it("throws a typed unresolved error when a bare basename has no match", async () => {
    const { getDirectorySuggestions } = suggestionsFromMap({});

    await expect(
      fetchDaemonResolution({
        ambiguousQuery: "file.ts",
        token: "file.ts",
        target: {
          raw: "file.ts",
          path: "/Users/test/project/file.ts",
          lineStart: undefined,
          lineEnd: undefined,
        },
        workspaceRoot: "/Users/test/project",
        getDirectorySuggestions,
      }),
    ).rejects.toEqual(new UnresolvedFileLinkError("file.ts"));
  });

  it("accepts spaces in inline-code paths but not in prose or commands", () => {
    expect(
      classifyForResolution(
        {
          href: "docs/최종 보고서.md",
          text: "docs/최종 보고서.md",
          sourceType: "inline-code",
        },
        CONTEXT,
      ),
    ).toMatchObject({
      kind: "needsLookup",
      target: { path: "/Users/test/project/docs/최종 보고서.md" },
    });
    expect(
      classifyForResolution(
        {
          href: "/Users/test/Documents/견적서 2026.xlsx",
          text: "/Users/test/Documents/견적서 2026.xlsx",
          sourceType: "inline-code",
        },
        CONTEXT,
      ),
    ).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "/Users/test/Documents/견적서 2026.xlsx",
          path: "/Users/test/Documents/견적서 2026.xlsx",
          lineStart: undefined,
          lineEnd: undefined,
        },
      },
    });
    expect(classifyForResolution({ href: "docs/최종 보고서.md" }, CONTEXT)).toEqual({
      kind: "resolved",
      value: { kind: "ignored" },
    });
    expect(
      classifyForResolution(
        {
          href: "git add src/a.ts src/b.ts",
          text: "git add src/a.ts src/b.ts",
          sourceType: "inline-code",
        },
        CONTEXT,
      ),
    ).toEqual({ kind: "resolved", value: { kind: "ignored" } });
  });

  it("throws a typed unresolved error when the daemon throws", async () => {
    await expect(
      fetchDaemonResolution({
        ambiguousQuery: "dumm.md",
        token: "dumm.md",
        target: {
          raw: "dumm.md",
          path: "/Users/test/project/dumm.md",
          lineStart: undefined,
          lineEnd: undefined,
        },
        workspaceRoot: "/Users/test/project",
        getDirectorySuggestions: unavailableSuggestions,
      }),
    ).rejects.toEqual(new UnresolvedFileLinkError("dumm.md"));
  });
});

describe("getAssistantFileLinkToken", () => {
  it("uses rendered text for markdown-it linkified tokens and href for explicit links", () => {
    expect(
      getAssistantFileLinkToken({
        href: "http://dumm.md",
        text: "dumm.md",
        markup: "linkify",
        sourceInfo: "auto",
      }),
    ).toBe("dumm.md");
    expect(
      getAssistantFileLinkToken({
        href: "http://google.com",
        text: "google.com",
        markup: "linkify",
        sourceInfo: "auto",
      }),
    ).toBe("http://google.com");
    expect(
      getAssistantFileLinkToken({
        href: "http://dumm.md",
        text: "dumm.md",
        markup: "",
        sourceInfo: "",
      }),
    ).toBe("http://dumm.md");
    expect(
      getAssistantFileLinkToken({
        href: "workspace-git-service.ts:1553",
        text: "workspace-git-service.ts:1553",
        sourceType: "inline-code",
      }),
    ).toBe("workspace-git-service.ts:1553");
  });
});

describe("path resolve (Daseo delta 90)", () => {
  const PLAN_CONTEXT = { workspaceRoot: "/Users/test/project", pathResolve: true };
  const inline = (text: string) => ({ href: text, text, sourceType: "inline-code" as const });

  it.each([
    [
      "an elided path with no head searches the workspace and home",
      inline("…/research/report.md"),
      {
        candidates: [],
        suffix: "research/report.md",
        searchRoots: ["/Users/test/project", "~"],
      },
    ],
    [
      "an elided path under home searches below its head",
      inline("~/.pi/…/research/report.md"),
      { candidates: [], suffix: "research/report.md", searchRoots: ["~/.pi"] },
    ],
    [
      "an elided relative path keeps its head as a constraint",
      inline("apps/mktg/.../schema.ts"),
      {
        candidates: [],
        suffix: "schema.ts",
        contains: "apps/mktg",
        searchRoots: ["/Users/test/project", "~"],
      },
    ],
    [
      "a bare name is tried at the root, then searched",
      inline("Daseo-0.5.101.apk"),
      {
        candidates: ["/Users/test/project/Daseo-0.5.101.apk"],
        suffix: "Daseo-0.5.101.apk",
        searchRoots: ["/Users/test/project"],
      },
    ],
    [
      "a relative markdown link written against a nested repo is searched (#8361)",
      { href: "schema/x.md", text: "x.md" },
      {
        candidates: ["/Users/test/project/schema/x.md"],
        suffix: "schema/x.md",
        searchRoots: ["/Users/test/project"],
      },
    ],
    [
      "an absolute link is only checked",
      { href: "/Users/test/Downloads/report.pdf", text: "report.pdf" },
      { candidates: ["/Users/test/Downloads/report.pdf"] },
    ],
    [
      "a home link with a space is decoded and only checked",
      { href: "~/brain/Memory/System%20Map.md", text: "System Map.md" },
      { candidates: ["~/brain/Memory/System Map.md"] },
    ],
  ])("%s", (_name, source, query) => {
    expect(planAssistantFileLink(source, PLAN_CONTEXT)).toMatchObject({
      kind: "needsPathResolve",
      query,
    });
  });

  it("keeps web addresses external and leaves elided paths unlinked without the daemon feature", () => {
    expect(planAssistantFileLink(inline("invite.folnua.com/seoulforest/"), PLAN_CONTEXT)).toEqual({
      kind: "resolved",
      value: { kind: "external", url: "https://invite.folnua.com/seoulforest/" },
    });
    expect(
      planAssistantFileLink(inline("…/research/report.md"), {
        workspaceRoot: "/Users/test/project",
        pathResolve: false,
      }),
    ).toEqual({ kind: "resolved", value: { kind: "ignored" } });
  });

  function daemon(result: Awaited<ReturnType<ResolvePath>>): ResolvePath {
    return async () => result;
  }
  const target = { raw: "…/report.md:3", path: "…/report.md", lineStart: 3 };
  const query = { candidates: [], suffix: "report.md" };

  it("opens the one match and keeps the line reference", async () => {
    await expect(
      resolvePathThroughDaemon({
        query,
        target,
        workspaceRoot: "/Users/test/project",
        resolvePath: daemon({
          matches: [{ path: "/Users/test/.pi/report.md", kind: "file" }],
          complete: true,
          error: null,
        }),
      }),
    ).resolves.toEqual({
      kind: "found",
      isDirectory: false,
      target: {
        raw: "…/report.md:3",
        path: "/Users/test/.pi/report.md",
        lineStart: 3,
        lineEnd: undefined,
      },
    });
  });

  it.each([
    [
      "ambiguous",
      {
        matches: [
          { path: "/a/report.md", kind: "file" as const },
          { path: "/b/report.md", kind: "file" as const },
        ],
        complete: true,
        error: null,
      },
    ],
    ["missing", { matches: [], complete: true, error: null }],
    ["incomplete", { matches: [], complete: false, error: null }],
    [
      "incomplete",
      { matches: [{ path: "/a/report.md", kind: "file" as const }], complete: false, error: null },
    ],
    ["missing", { matches: [], complete: true, error: "boom" }],
  ])("never opens a guess: %s", async (kind, result) => {
    await expect(
      resolvePathThroughDaemon({
        query,
        target,
        workspaceRoot: "/Users/test/project",
        resolvePath: daemon(result),
      }),
    ).resolves.toEqual({ kind });
  });
});
