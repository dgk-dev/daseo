import { describe, expect, it } from "vitest";
import { formatShellPrompt, resolveShellPrompt } from "./shell-prompt";

describe("resolveShellPrompt", () => {
  it("takes the user from the home folder and shows that home as ~", () => {
    expect(
      resolveShellPrompt({ cwd: "/Users/ddgk/ws/hym", hostname: "Guesuks-Mac-mini.local" }),
    ).toEqual({ user: "ddgk", host: "Guesuks-Mac-mini", path: "~/ws/hym" });
  });

  it("shows the home folder itself as ~ and trims a trailing slash", () => {
    expect(resolveShellPrompt({ cwd: "/home/dev/", hostname: "box" })).toEqual({
      user: "dev",
      host: "box",
      path: "~",
    });
    expect(resolveShellPrompt({ cwd: "/root/app", hostname: "box" }).user).toBe("root");
  });

  it("keeps a path outside any home and drops the user", () => {
    expect(resolveShellPrompt({ cwd: "/srv/app", hostname: "box" })).toEqual({
      user: null,
      host: "box",
      path: "/srv/app",
    });
  });

  it("does not take a sibling of a home folder for a home", () => {
    expect(resolveShellPrompt({ cwd: "/Users", hostname: "box" }).user).toBeNull();
  });

  it("falls back to the host label, and keeps an IP address whole", () => {
    expect(
      resolveShellPrompt({ cwd: "/Users/a", hostname: null, hostLabel: "Mac mini" }).host,
    ).toBe("Mac mini");
    expect(resolveShellPrompt({ cwd: "/Users/a", hostname: "100.77.77.8" }).host).toBe(
      "100.77.77.8",
    );
  });
});

describe("formatShellPrompt", () => {
  const parts = { user: "ddgk", host: "mac", path: "~/hym" };

  it("prints Ubuntu's PS1 shape", () => {
    expect(formatShellPrompt(parts, { compact: false })).toBe("ddgk@mac:~/hym$");
  });

  it("keeps only the path on compact layouts", () => {
    expect(formatShellPrompt(parts, { compact: true })).toBe("~/hym$");
  });

  it("drops what it does not know", () => {
    expect(formatShellPrompt({ user: null, host: "mac", path: "/srv" }, { compact: false })).toBe(
      "mac:/srv$",
    );
    expect(formatShellPrompt({ user: null, host: null, path: null }, { compact: false })).toBe("$");
  });
});
