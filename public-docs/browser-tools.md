---
title: Browser tools
description: The browser_* MCP tools agents use to drive Paseo browser tabs.
nav: Tools reference
order: 37
category: Browser
---

# Browser tools

The `browser_*` tools are injected into agents alongside the other [Paseo MCP tools](/docs/mcp) when [browser automation](/docs/browser) is enabled.

Shared concepts:

- **`browserId`** identifies a tab. It comes from `browser_new_tab` or `browser_list_tabs` and is required by every tab-scoped tool.
- **`ref`** identifies an element, e.g. `@e3`. Refs come from the latest `browser_snapshot` of the same tab and expire when the page changes — stale refs return an error instead of acting on the wrong element. Elements inside same-origin iframes get refs like any other; a cross-origin iframe shows only its `src`.
- Every result reports **dialogs** the page opened during the command (alerts accepted; confirm/prompt/beforeunload dismissed).

Arguments marked `?` are optional.

## Tabs

| Tool                | Arguments                                                           | Purpose                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_list_tabs` | —                                                                   | List open tabs in the agent's workspace across connected hosts.                                                                                                                                                                                                               |
| `browser_new_tab`   | `url?`                                                              | Open a tab in the background and return its `browserId`.                                                                                                                                                                                                                      |
| `browser_close_tab` | `browserId`                                                         | Close a tab and clean up its webview.                                                                                                                                                                                                                                         |
| `browser_resize`    | `browserId, width, height, mobile?, userAgent?, deviceScaleFactor?` | Resize the tab's viewport — check a layout at phone or tablet dimensions. `mobile` also emulates a phone (touch, DPR 3, Android Chrome user agent and client hints); `userAgent` sets any user agent, such as an in-app browser's. A resize without them turns emulation off. |

## Reading the page

| Tool                 | Arguments                                                                                                                                                                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_snapshot`   | `browserId, ref?, interactive?`                                                                                                                                            | Return the page as an accessibility tree with element refs; `ref` shows one element's subtree, `interactive` only elements with refs and their named containers.                                                                                                                                                                                                                               |
| `browser_read`       | `browserId, scope?, ref?, links?, maxChars?`                                                                                                                               | Return the page as Markdown: the main content (Readability, falling back to the whole page), the whole page, or one `ref`. Product and article data from JSON-LD and meta tags comes first.                                                                                                                                                                                                    |
| `browser_find`       | `browserId, role?, name?, exact?, limit?`                                                                                                                                  | Find elements by role and accessible name; actionable matches return refs. `name` is a case-insensitive substring, exact with `exact`, or `/regex/flags`.                                                                                                                                                                                                                                      |
| `browser_screenshot` | `browserId, fullPage?, ref?, savePath?`                                                                                                                                    | Capture a PNG of the viewport, the full page with `fullPage`, or one element with `ref`; `savePath` also writes the file.                                                                                                                                                                                                                                                                      |
| `browser_logs`       | `browserId, maxEntries?, level?`                                                                                                                                           | Read recent console messages (uncaught errors included; earlier pages' marked `previousPage`) and the page's requests with HTTP status. `level` keeps that severity and above.                                                                                                                                                                                                                 |
| `browser_styles`     | `browserId, ref, properties?, maxRules?`                                                                                                                                   | Show the CSS behind an element as DevTools does: matched rules by precedence with stylesheet URL and line, overridden and invalid declarations, inherited properties, computed values.                                                                                                                                                                                                         |
| `browser_passkeys`   | `action?, browserId?, account?, credentialId?, rpId?`                                                                                                                      | Passkeys in the browser: an agent-owned software authenticator keeps the passkeys sites register and signs in with a stored one when asked (a click on the site's passkey button, or `use`), never on page load. `list` shows them, `status` says whether the tab's site has one and which request the page waits on, `use` answers it (`account` picks one of several), `delete` removes one. |
| `browser_network`    | `browserId, action, urlIncludes?, method?, resourceType?, since?, maxEntries?, includeBodies?, includeRequestBodies?, includeResponseHeaders?, path?, bodies?, overwrite?` | Start, list, export, or stop a per-tab capture of the page's requests with their payloads and responses. Cookie and Authorization values and password fields are redacted. `export` writes a sanitized HAR 1.2 file (see below).                                                                                                                                                               |
| `browser_wait`       | `browserId, text? \| url? \| selector? \| script? \| load?, timeoutMs?`                                                                                                    | Wait for exactly one condition: page text, a URL fragment, a CSS selector, a script that returns a truthy value, or `load`/`networkidle`. `timeoutMs` alone pauses.                                                                                                                                                                                                                            |

### Exporting network captures

`browser_network` with `action: "export"` writes the tab's capture to one HAR 1.2 file and returns its path and a summary; the capture keeps running. The file is written by the desktop app, on the machine that runs it: `path` is resolved against the agent's working directory (`~/` is the home directory), and without one it goes to `~/Downloads/Daseo/network-<host>-<time>.har`. An existing file is replaced only with `overwrite: true`.

- API-type response bodies (XHR, fetch, document, EventSource, and other textual responses) are kept from the moment they finish, up to 2 MB each, so a navigation does not lose them. `bodies: "none"` leaves them out. Scripts, stylesheets, images, fonts, and media are never embedded.
- Redirect hops, response headers, timings, and WebSocket frames are included. Requests still in flight are counted, not written, and so are requests for `data:`, `blob:`, `about:`, and other URLs that never touched the network.
- The file is always sanitized: credential headers and cookies, secret query, form, and JSON fields, and JWTs are replaced with `<redacted-N>` placeholders, and the same placeholder marks every other place the value appears. Personal data in bodies, such as names and e-mail addresses, is not removed; keep the file private.

The file opens in Chrome DevTools and converts with `har-to-openapi`. With `--validate`, `har-to-openapi` rejects a file that holds a WebSocket (`ws:`) entry, so export with `includeWebSocket: false`, convert a copy with only `http(s)` entries, or run it without `--validate`.

## Interacting

| Tool               | Arguments                                           | Purpose                                                                              |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `browser_click`    | `browserId, ref, button?, doubleClick?, modifiers?` | Click an element — left/right/middle, double-click, keyboard modifiers.              |
| `browser_fill`     | `browserId, ref, value`                             | Set the value of an input-like element.                                              |
| `browser_type`     | `browserId, text, ref?`                             | Type text into an element, or into the focused element when `ref` is omitted.        |
| `browser_keypress` | `browserId, key, ref?`                              | Press a key (`Enter`, `Escape`, `Tab`, `Space`, …) on an element or the focused one. |
| `browser_hover`    | `browserId, ref`                                    | Hover an element — triggers real CSS `:hover`.                                       |
| `browser_select`   | `browserId, ref, value`                             | Choose an option in a `<select>`.                                                    |
| `browser_drag`     | `browserId, sourceRef, targetRef`                   | Drag one element onto another.                                                       |
| `browser_upload`   | `browserId, ref, filePaths`                         | Set files on a file input. Paths must be inside the agent's workspace.               |
| `browser_scroll`   | `browserId, deltaX, deltaY, ref?`                   | Scroll the page, or center the wheel input over an element with `ref`.               |

## Navigation

| Tool               | Arguments        | Purpose                                                       |
| ------------------ | ---------------- | ------------------------------------------------------------- |
| `browser_navigate` | `browserId, url` | Go to an `http(s)` URL and report the response's HTTP status. |
| `browser_back`     | `browserId`      | Go back — errors when there is no history to go to.           |
| `browser_forward`  | `browserId`      | Go forward — errors when there is no forward entry.           |
| `browser_reload`   | `browserId`      | Reload the page.                                              |

## Scripting

| Tool               | Arguments                   | Purpose                                                                                                                                  |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_evaluate` | `browserId, function, ref?` | Run a JavaScript function in the page. With `ref`, the resolved element is passed as the first argument. Results return as bounded JSON. |

## Errors

Tools return structured errors rather than failing silently. The ones agents see most:

| Code                | Meaning                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `browser_disabled`  | Browser tools are turned off on this host.                                      |
| `browser_no_host`   | No browser host (desktop app) is connected. Retryable.                          |
| `browser_stale_ref` | The ref no longer matches the page — take a new snapshot.                       |
| `browser_timeout`   | The element never became actionable, or the wait condition never held.          |
| `browser_denied`    | The action isn't allowed — e.g. a non-`http(s)` URL, or no history to navigate. |
