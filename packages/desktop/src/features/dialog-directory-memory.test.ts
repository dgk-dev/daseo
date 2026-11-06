import { describe, expect, it } from "vitest";
import { createDialogDirectoryMemory } from "./dialog-directory-memory.js";

describe("createDialogDirectoryMemory", () => {
  it("leaves the first dialog to the platform default", () => {
    expect(createDialogDirectoryMemory().defaultPath(undefined)).toBeUndefined();
  });

  it("opens the next dialog in the folder of the last selection", () => {
    const memory = createDialogDirectoryMemory();
    memory.remember(["/Users/me/projects/app", "/Users/me/projects/other"]);
    expect(memory.defaultPath(undefined)).toBe("/Users/me/projects");
  });

  it("keeps an explicit default path from the caller", () => {
    const memory = createDialogDirectoryMemory();
    memory.remember(["/Users/me/projects/app/readme.md"]);
    expect(memory.defaultPath("/tmp/explicit")).toBe("/tmp/explicit");
  });

  it("ignores cancelled and relative selections", () => {
    const memory = createDialogDirectoryMemory();
    memory.remember(["/Users/me/pictures/shot.png"]);
    memory.remember([]);
    memory.remember(["relative/file.txt"]);
    expect(memory.defaultPath(undefined)).toBe("/Users/me/pictures");
  });
});
