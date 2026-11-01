// Daseo delta 75: where a file link opens on the phone, decided from the extension before
// anything is downloaded. Text the app can show (markdown, HTML, source, logs, data) and the
// images React Native decodes open in Daseo's file pane; the pane offers "open in another app".
// Everything else — PDF, office and HWP documents, media, archives, databases, and any unknown
// extension — goes to an Android app as delta 62 does, because Daseo has no viewer for it.
//
// SVG, HEIC, BMP, TIFF, and ICO stay external: the daemon reads only png/jpg/gif/webp/svg as
// images, and React Native's image decoder has no SVG support, so the pane would show "no
// preview" or a spinner for them where the gallery or Chrome shows the picture.

export type NativeOpenRoute = "in-app" | "external";

const IN_APP_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

const IN_APP_TEXT_EXTENSIONS = new Set([
  // Rendered: markdown preview and the sandboxed HTML preview.
  "md",
  "markdown",
  "mdx",
  "htm",
  "html",
  // Plain text, logs, and data.
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonc",
  "jsonl",
  "ndjson",
  "ipynb",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "lock",
  "sql",
  "diff",
  "patch",
  // Source.
  "astro",
  "bash",
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "cts",
  "cxx",
  "fish",
  "go",
  "gql",
  "gradle",
  "graphql",
  "h",
  "hpp",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "less",
  "lua",
  "mjs",
  "mts",
  "php",
  "proto",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
  "zsh",
]);

/** The lowercase extension of a path's last segment; a dotfile's name counts (`.env` → `env`). */
export function fileExtension(filePath: string): string | null {
  const name =
    filePath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) {
    return null;
  }
  return name.slice(dot + 1).toLowerCase();
}

export function nativeOpenRoute(filePath: string): NativeOpenRoute {
  const extension = fileExtension(filePath);
  if (!extension) {
    return "external";
  }
  if (IN_APP_TEXT_EXTENSIONS.has(extension) || IN_APP_IMAGE_EXTENSIONS.has(extension)) {
    return "in-app";
  }
  return "external";
}
