import { describe, expect, it } from "vitest";
import {
  classifyAssistantFileLink,
  normalizeInlinePathTarget,
  parseAssistantFileLink,
  parseFileProtocolUrl,
  parseInlinePathToken,
} from "./parse";

describe("parseInlinePathToken", () => {
  it("returns null for plain paths without a line number", () => {
    expect(parseInlinePathToken("src/app.ts")).toBeNull();
    expect(parseInlinePathToken("README.md")).toBeNull();
  });

  it("parses filename:line", () => {
    expect(parseInlinePathToken("src/app.ts:12")).toEqual({
      raw: "src/app.ts:12",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("parses filename:lineStart-lineEnd", () => {
    expect(parseInlinePathToken("src/app.ts:12-20")).toEqual({
      raw: "src/app.ts:12-20",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("parses filename:line:column as a line target", () => {
    expect(parseInlinePathToken("src/app.ts:12:4")).toEqual({
      raw: "src/app.ts:12:4",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("parses filename(line,column) as a line target", () => {
    expect(parseInlinePathToken("src/app.ts(12,4)")).toEqual({
      raw: "src/app.ts(12,4)",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("parses filename lines lineStart-lineEnd", () => {
    expect(parseInlinePathToken("src/app.ts lines 12-20")).toEqual({
      raw: "src/app.ts lines 12-20",
      path: "src/app.ts",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("rejects range-only :line tokens", () => {
    expect(parseInlinePathToken(":12")).toBeNull();
    expect(parseInlinePathToken(":12-20")).toBeNull();
  });
});

describe("parseFileProtocolUrl", () => {
  it("parses file URLs with line fragments", () => {
    expect(parseFileProtocolUrl("file:///Users/test/project/src/app.tsx#L81")).toEqual({
      raw: "file:///Users/test/project/src/app.tsx#L81",
      path: "/Users/test/project/src/app.tsx",
      lineStart: 81,
      lineEnd: undefined,
    });
  });

  it("parses file URLs with line-column fragments", () => {
    expect(parseFileProtocolUrl("file:///Users/test/project/src/app.tsx#L81C5-L83C2")).toEqual({
      raw: "file:///Users/test/project/src/app.tsx#L81C5-L83C2",
      path: "/Users/test/project/src/app.tsx",
      lineStart: 81,
      lineEnd: 83,
    });
  });

  it("parses file URLs without line fragments", () => {
    expect(parseFileProtocolUrl("file:///Users/test/project/src/app.tsx")).toEqual({
      raw: "file:///Users/test/project/src/app.tsx",
      path: "/Users/test/project/src/app.tsx",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("parses windows file URLs and line ranges", () => {
    expect(parseFileProtocolUrl("file:///C:/Users/test/project/src/app.tsx#L12-L20")).toEqual({
      raw: "file:///C:/Users/test/project/src/app.tsx#L12-L20",
      path: "C:/Users/test/project/src/app.tsx",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("rejects non-file URLs and invalid ranges", () => {
    expect(parseFileProtocolUrl("https://example.com/test.ts#L10")).toBeNull();
    expect(parseFileProtocolUrl("file:///Users/test/project/src/app.tsx#L20-L12")).toBeNull();
  });
});

describe("classifyAssistantFileLink", () => {
  it("keeps explicit external URLs out of file parsing", () => {
    expect(
      classifyAssistantFileLink("http://dumm.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "external",
      raw: "http://dumm.md",
    });
    expect(classifyAssistantFileLink("mailto:test@example.com")).toEqual({
      kind: "external",
      raw: "mailto:test@example.com",
    });
  });

  it("classifies bare workspace candidates separately from direct relative files", () => {
    expect(
      classifyAssistantFileLink("dumm.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "ambiguousFileCandidate",
      target: {
        raw: "dumm.md",
        path: "/Users/test/project/dumm.md",
        lineStart: undefined,
        lineEnd: undefined,
      },
    });

    expect(
      classifyAssistantFileLink("message-renderer.tsx", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "ambiguousFileCandidate",
      target: {
        raw: "message-renderer.tsx",
        path: "/Users/test/project/message-renderer.tsx",
        lineStart: undefined,
        lineEnd: undefined,
      },
    });

    expect(
      classifyAssistantFileLink("src/components/message.tsx#L33", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      kind: "directFile",
      target: {
        raw: "src/components/message.tsx#L33",
        path: "/Users/test/project/src/components/message.tsx",
        lineStart: 33,
        lineEnd: undefined,
      },
    });
  });

  it("opens bare domains as https websites, never as file candidates", () => {
    expect(
      classifyAssistantFileLink("google.com", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({ kind: "external", raw: "https://google.com" });
    expect(
      classifyAssistantFileLink("example.com", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({ kind: "external", raw: "https://example.com" });
    expect(
      classifyAssistantFileLink("openai.com/path", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({ kind: "external", raw: "https://openai.com/path" });
  });

  it("does not classify plain inline code words or identifiers as file candidates", () => {
    for (const value of [
      "main",
      "origin/main",
      "1f7fc232b",
      "25994904967",
      "babysit main 1f7fc232b",
    ]) {
      expect(
        classifyAssistantFileLink(value, {
          workspaceRoot: "/Users/test/project",
        }),
      ).toBeNull();
    }
  });

  it("links documents, data, and media by extension", () => {
    for (const value of [
      "docs/report.xlsx",
      "out/견적서.pdf",
      "exports/data.csv",
      "shots/home.png",
    ]) {
      expect(
        classifyAssistantFileLink(value, {
          workspaceRoot: "/Users/test/project",
        }),
      ).toMatchObject({
        kind: "directFile",
        target: { path: `/Users/test/project/${value}` },
      });
    }
    expect(
      classifyAssistantFileLink("보고서.hwp", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toMatchObject({ kind: "ambiguousFileCandidate" });
    // Any short extension counts once a directory is named; bare words do not.
    expect(
      classifyAssistantFileLink("build/output.bin", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toMatchObject({ kind: "directFile" });
    expect(
      classifyAssistantFileLink("output.bin", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
    expect(
      classifyAssistantFileLink("hymdosan.com", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({ kind: "external", raw: "https://hymdosan.com" });
  });

  it("accepts spaces only when allowed and the token still reads as one path", () => {
    const root = { workspaceRoot: "/Users/test/project" };
    expect(classifyAssistantFileLink("docs/최종 보고서.md", root)).toBeNull();
    expect(
      classifyAssistantFileLink("docs/최종 보고서.md", {
        ...root,
        allowWhitespace: true,
      }),
    ).toMatchObject({
      target: { path: "/Users/test/project/docs/최종 보고서.md" },
    });
    expect(
      classifyAssistantFileLink("~/Documents/지급 내역 2026.xlsx", {
        ...root,
        allowWhitespace: true,
      }),
    ).toMatchObject({ target: { path: "~/Documents/지급 내역 2026.xlsx" } });
    expect(
      classifyAssistantFileLink("/tmp/회의 녹취록.txt:12", {
        ...root,
        allowWhitespace: true,
      }),
    ).toMatchObject({
      target: { path: "/tmp/회의 녹취록.txt", lineStart: 12 },
    });
    for (const command of [
      "git add src/a.ts src/b.ts",
      "cat docs/a.md | head",
      "docs/a.md -n 3",
      "npm run lint -- packages/app/src/x.ts",
      "src/a.ts && src/b.ts",
    ]) {
      expect(classifyAssistantFileLink(command, { ...root, allowWhitespace: true })).toBeNull();
    }
  });

  it("does not classify shell commands containing path arguments as file candidates", () => {
    expect(
      classifyAssistantFileLink(
        "npm run lint -- packages/app/src/stores/workspace-layout-actions.ts packages/app/src/stores/workspace-layout-store.ts packages/app/src/screens/workspace/workspace-screen.tsx",
        {
          workspaceRoot: "/Users/test/project",
        },
      ),
    ).toBeNull();
  });
});

describe("parseAssistantFileLink", () => {
  it("resolves bare markdown filenames against the active workspace", () => {
    expect(
      parseAssistantFileLink("dumm.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "dumm.md",
      path: "/Users/test/project/dumm.md",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("resolves bare source filenames with line suffixes against the active workspace", () => {
    expect(
      parseAssistantFileLink("file.ts:12", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "file.ts:12",
      path: "/Users/test/project/file.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("rejects bare domains and domain-like paths", () => {
    expect(
      parseAssistantFileLink("google.com", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
    expect(
      parseAssistantFileLink("google.com:80", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
    expect(
      parseAssistantFileLink("openai.com/path", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });

  it("resolves relative paths against the active workspace", () => {
    expect(
      parseAssistantFileLink("src/components/message.tsx#L33", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "src/components/message.tsx#L33",
      path: "/Users/test/project/src/components/message.tsx",
      lineStart: 33,
      lineEnd: undefined,
    });
  });

  it("parses absolute POSIX hrefs inside the active workspace", () => {
    expect(
      parseAssistantFileLink("/Users/test/project/src/app.tsx#L33", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "/Users/test/project/src/app.tsx#L33",
      path: "/Users/test/project/src/app.tsx",
      lineStart: 33,
      lineEnd: undefined,
    });
  });

  it("parses absolute POSIX hrefs with VS Code-style line suffixes inside the active workspace", () => {
    expect(
      parseAssistantFileLink("/Users/test/project/src/app.tsx:33", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "/Users/test/project/src/app.tsx:33",
      path: "/Users/test/project/src/app.tsx",
      lineStart: 33,
      lineEnd: undefined,
    });
  });

  it("parses absolute Windows hrefs inside the active workspace", () => {
    expect(
      parseAssistantFileLink("C:/repo/src/app.tsx#L12-L20", {
        workspaceRoot: "C:/repo",
      }),
    ).toEqual({
      raw: "C:/repo/src/app.tsx#L12-L20",
      path: "C:/repo/src/app.tsx",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("parses absolute Windows hrefs with VS Code-style line suffixes inside the active workspace", () => {
    expect(
      parseAssistantFileLink("C:/repo/src/app.tsx:12-20", {
        workspaceRoot: "C:/repo",
      }),
    ).toEqual({
      raw: "C:/repo/src/app.tsx:12-20",
      path: "C:/repo/src/app.tsx",
      lineStart: 12,
      lineEnd: 20,
    });
  });

  it("allows file URLs even when they are outside the workspace root", () => {
    expect(
      parseAssistantFileLink("file:///tmp/outside.txt", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "file:///tmp/outside.txt",
      path: "/tmp/outside.txt",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("allows absolute hrefs outside the workspace root", () => {
    expect(
      parseAssistantFileLink("/tmp/outside.txt", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "/tmp/outside.txt",
      path: "/tmp/outside.txt",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("keeps tilde hrefs as direct home-relative file targets", () => {
    expect(
      parseAssistantFileLink("~/.paseo/plans/file-preview.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "~/.paseo/plans/file-preview.md",
      path: "~/.paseo/plans/file-preview.md",
      lineStart: undefined,
      lineEnd: undefined,
    });
    expect(
      parseAssistantFileLink("~/.paseo/plans/file-preview.md:12", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "~/.paseo/plans/file-preview.md:12",
      path: "~/.paseo/plans/file-preview.md",
      lineStart: 12,
      lineEnd: undefined,
    });
    expect(
      parseAssistantFileLink("~\\.paseo\\plans\\file-preview.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toEqual({
      raw: "~\\.paseo\\plans\\file-preview.md",
      path: "~/.paseo/plans/file-preview.md",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  it("rejects external URLs", () => {
    expect(parseAssistantFileLink("https://example.com/Users/test/project/src/app.tsx")).toBeNull();
    expect(
      parseAssistantFileLink("http://dumm.md", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });

  it("rejects invalid line fragments", () => {
    expect(
      parseAssistantFileLink("/Users/test/project/src/app.tsx#L20-L12", {
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });

  it("does not throw when the input contains a literal '%' that is not a valid percent-escape", () => {
    // Regressions for tool output strings like ping's "100% packet loss",
    // Windows "%PATH%" references, and percentages such as "0% off".
    // decodeURIComponent throws URIError on these; the parser must swallow
    // it and return null rather than crash the renderer.
    const cases = [
      "/tmp/100% packet loss",
      "/Users/test/project/0% off",
      "/var/log/%PATH%/x.log",
      "file:///tmp/100% packet loss",
    ];
    for (const value of cases) {
      expect(() =>
        parseAssistantFileLink(value, { workspaceRoot: "/Users/test/project" }),
      ).not.toThrow();
    }
    expect(() => parseFileProtocolUrl("file:///tmp/100% packet loss")).not.toThrow();
  });
});

describe("normalizeInlinePathTarget", () => {
  it("keeps relative file paths as file targets", () => {
    expect(normalizeInlinePathTarget("packages/app/src/components/message.tsx")).toEqual({
      directory: "packages/app/src/components",
      file: "packages/app/src/components/message.tsx",
    });
  });

  it("resolves absolute paths under cwd back to workspace-relative paths", () => {
    expect(
      normalizeInlinePathTarget(
        "/Users/test/project/packages/app/src/components/message.tsx",
        "/Users/test/project",
      ),
    ).toEqual({
      directory: "packages/app/src/components",
      file: "packages/app/src/components/message.tsx",
    });
  });

  it("keeps absolute paths outside cwd as absolute file targets", () => {
    expect(normalizeInlinePathTarget("/tmp/message.tsx", "/Users/test/project")).toEqual({
      directory: "/tmp",
      file: "/tmp/message.tsx",
    });
  });

  it("keeps tilde paths as home-relative file targets", () => {
    expect(
      normalizeInlinePathTarget("~/.paseo/plans/file-preview.md", "/Users/test/project"),
    ).toEqual({
      directory: "~/.paseo/plans",
      file: "~/.paseo/plans/file-preview.md",
    });
  });

  it("treats cwd itself as the workspace root directory", () => {
    expect(normalizeInlinePathTarget("/Users/test/project", "/Users/test/project")).toEqual({
      directory: ".",
    });
  });

  it("keeps trailing-slash paths as directories", () => {
    expect(
      normalizeInlinePathTarget("/Users/test/project/packages/app/", "/Users/test/project"),
    ).toEqual({
      directory: "packages/app",
    });
  });
});

describe("link tolerance (Daseo delta 90)", () => {
  const root = { workspaceRoot: "/Users/test/project" };

  it("keeps a path shortened with an ellipsis as a search, never as a file", () => {
    expect(classifyAssistantFileLink("…/research/2026-11-09-report.md", root)).toMatchObject({
      kind: "elidedPath",
      head: "",
      suffix: "research/2026-11-09-report.md",
    });
    expect(classifyAssistantFileLink(".../verify-pc.log", root)).toMatchObject({
      kind: "elidedPath",
      head: "",
      suffix: "verify-pc.log",
    });
    expect(classifyAssistantFileLink("~/.pi/agent/…/research/x.md", root)).toMatchObject({
      kind: "elidedPath",
      head: "~/.pi/agent",
      suffix: "research/x.md",
    });
    expect(classifyAssistantFileLink("apps/mktg/.../app-schema-migrations.ts:12", root)).toEqual({
      kind: "elidedPath",
      head: "apps/mktg",
      suffix: "app-schema-migrations.ts",
      target: {
        raw: "apps/mktg/.../app-schema-migrations.ts:12",
        path: "apps/mktg/.../app-schema-migrations.ts",
        lineStart: 12,
        lineEnd: undefined,
      },
    });
  });

  it("does not link an ellipsis that names no single file", () => {
    for (const value of [
      "…/",
      "…",
      "…/assets/*.png",
      "…/research/{a,b}.md",
      "…/answer/14693848",
      "www.coupang.com/vp/products/…",
    ]) {
      expect(classifyAssistantFileLink(value, root)).toBeNull();
    }
  });

  it("opens a scheme-less web address over https", () => {
    for (const value of [
      "invite.folnua.com/seoulforest/",
      "mac.tail29eaf5.ts.net",
      "hdexwear.com/hd/fit-guide.html",
      "h-dex.jp/hd/fit-guide.html",
      "naver.com",
    ]) {
      expect(classifyAssistantFileLink(value, root)).toEqual({
        kind: "external",
        raw: `https://${value}`,
      });
    }
  });

  it("never reads a file name or a version as a web address", () => {
    expect(classifyAssistantFileLink("file.html", root)).toMatchObject({
      kind: "ambiguousFileCandidate",
    });
    expect(classifyAssistantFileLink("index.ts", root)).toMatchObject({
      kind: "ambiguousFileCandidate",
    });
    expect(classifyAssistantFileLink("app.module.ts", root)).toMatchObject({
      kind: "ambiguousFileCandidate",
    });
    expect(classifyAssistantFileLink("README.md", root)).toMatchObject({
      kind: "ambiguousFileCandidate",
    });
    for (const value of ["0.5.101", "Daseo.app", "claude.ai", "100.125.123.120:5555"]) {
      expect(classifyAssistantFileLink(value, root)).toBeNull();
    }
  });

  it("links bare names of builds, installers, media, and documents", () => {
    for (const value of [
      "Daseo-0.5.101.apk",
      "app-release.aab",
      "Daseo-0.5.101-mac-arm64.dmg",
      "photo.heic",
      "demo.mov",
      "demo.mp4",
      "memo.m4a",
      "take.wav",
      "song.mp3",
      "book.epub",
      "보고서.hwpx",
      "sheet.numbers",
      "letter.pages",
      "deck.key",
    ]) {
      expect(classifyAssistantFileLink(value, root)).toMatchObject({
        kind: "ambiguousFileCandidate",
        target: { path: `/Users/test/project/${value}` },
      });
    }
  });

  it("links a bare name with spaces in inline code, but not a command", () => {
    const inline = { ...root, allowWhitespace: true };
    expect(classifyAssistantFileLink("회사 자료 접근 지도.md", inline)).toMatchObject({
      kind: "ambiguousFileCandidate",
      target: { path: "/Users/test/project/회사 자료 접근 지도.md" },
    });
    expect(classifyAssistantFileLink("회사 자료 접근 지도.md", root)).toBeNull();
    expect(classifyAssistantFileLink("open report.pdf", inline)).toBeNull();
    expect(classifyAssistantFileLink("Release notes for v2", inline)).toBeNull();
  });

  it("decodes an authored destination and takes it as written", () => {
    const explicit = { ...root, explicitLink: true };
    expect(classifyAssistantFileLink("~/brain/Memory/System%20Map.md", explicit)).toMatchObject({
      kind: "directFile",
      target: { path: "~/brain/Memory/System Map.md" },
    });
    expect(
      classifyAssistantFileLink(
        "docs/%EC%B5%9C%EC%A2%85%20%EB%B3%B4%EA%B3%A0%EC%84%9C.md",
        explicit,
      ),
    ).toMatchObject({
      kind: "directFile",
      target: { path: "/Users/test/project/docs/최종 보고서.md" },
    });
    expect(classifyAssistantFileLink("docs/guides", explicit)).toMatchObject({
      kind: "directFile",
      target: { path: "/Users/test/project/docs/guides" },
    });
    expect(classifyAssistantFileLink("capture.png", explicit)).toMatchObject({
      kind: "directFile",
      target: { path: "/Users/test/project/capture.png" },
    });
    expect(classifyAssistantFileLink("%E2%80%A6/research/x.md", explicit)).toMatchObject({
      kind: "elidedPath",
      suffix: "research/x.md",
    });
    expect(classifyAssistantFileLink("invite.folnua.com/seoulforest/", explicit)).toEqual({
      kind: "external",
      raw: "https://invite.folnua.com/seoulforest/",
    });
  });
});
