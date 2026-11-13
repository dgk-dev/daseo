# Browser Capture Harness

The desktop capture harness is the real-Electron verification path for browser screenshots.
It validates the compositor behavior that unit tests cannot see:

- the resident automation `<webview>` starts in the production parking state;
- the parked guest remains paintable and has a copyable viewport frame;
- a never-presented resident webview guest defaults to 1280x800 logical pixels;
- multiple resident webviews are parked as an overlapping stack without per-capture
  stacking changes;
- a newly attached resident webview whose first useful frame is delayed can be captured
  by retrying until the frame appears;
- both viewport `capturePage` and the compiled production full-page capture return real pixels
  from the permanent production parking state, including the fixture's bottom marker;
- a parked guest in the tab lifecycle's active state (background throttling off, which
  every capture holds) needs no per-capture renderer coordination;
- the real-Electron host-composer sentinel proves guest Enter cannot submit a focused
  host composer;
- production browser click, drag, type, remote tap, and remote text paths can operate a
  background guest without blurring or changing the host composer;
- the automation group loads the compiled production keyboard boundary and guest
  preload, then proves that initial page window handlers get first refusal, unhandled
  shortcuts synchronously suppress editable browser defaults before crossing the host
  boundary, shortcuts marked unavailable in editable targets retain the browser field's
  native behavior, handlers registered after preload still get first refusal, focused
  iframes share the same boundary, digit wildcard shortcuts cross, and background automation
  stays in the guest.

Run it with the repo Electron:

```bash
npm run capture-harness --workspace=@getpaseo/desktop
```

The command builds the desktop main process first so the harness exercises the compiled
production full-page capture, keyboard boundary, and guest preload. Run the automation group with:

```bash
PASEO_CAPTURE_HARNESS_GROUP=automation npm run capture-harness --workspace=@getpaseo/desktop
```

Run the shared browser profile fixture with:

```bash
PASEO_CAPTURE_HARNESS_GROUP=browser-profile npm run capture-harness --workspace=@getpaseo/desktop
```

The browser profile group runs two Electron processes in sequence. It verifies that each
renderer-side `did-attach` identity maps to the correct main-process guest, that two live
tabs share cookies and local storage through one persistent session, and that the data is
still present after the first Electron process exits and the second starts.

The passkeys group (`PASEO_CAPTURE_HARNESS_GROUP=passkeys`) wires the compiled passkey hub to
real guests the way `main.ts` does and serves a `localhost` page that calls
`navigator.credentials.create()` and `get()`: a site with no stored passkey fails in milliseconds,
a passkey the page registers lands in the store encrypted and signs in from a second guest and
after a navigation with a rising counter, and `browser_passkeys status` and `delete` run through
the production service. Delta 102 cases: passkey autofill started on page load stays pending for
3 s and `passkey_use` answers it; a modal request with no gesture waits too; the production
background click on the page's passkey button signs in at once and aborts the autofill request;
with two stored accounts the click waits, the pane surface is shown, `passkey_use` without an
account lists both masked and with one signs that account in. Pages get a user gesture only from
real input or `executeJavaScript(code, true)`, so the checks that must not sign in run their page
code with `false`.

The delta92 group (`PASEO_CAPTURE_HARNESS_GROUP=delta92`) serves a page that holds one image
open forever, a page that alerts while it loads, a download link, and a page that busy-loops. It
checks that snapshot and evaluate answer on the never-finishing load (marked `loading`), that the
alert is answered and reported while the navigation returns, that a download the agent clicks
lands in the downloads folder with no dialog and `browser_wait download` returns it, that the
busy page is reported as not responding within seconds, and that a crashed renderer is recorded.
A `loadURL` issued while another load is still running is rejected with that load's abort, so
the group stops the hanging load before the dialog check.

The tab-discard group (`PASEO_CAPTURE_HARNESS_GROUP=tab-discard`) shortens the tab lifecycle to
1 s throttle, 2 s freeze, and 5 s idle discard through `PASEO_BROWSER_TAB_LIFECYCLE_MS`, opens
three real guests, types into one with the production `type` command, presents another, and runs
the production discard check until the third is discarded. It checks through the tab report that
only that tab lost its renderer (the typed one reports `edited`), that its renderer process ended,
and that `browser_snapshot` on it reloads the page and answers with the parsed document. The
fixture holds the idle page's body back 400 ms, so a wake that did not wait for the document fails.
Each guest is reloaded once after main starts watching it: the edit watcher installs at
`dom-ready`, and a page that loaded before it counts as edited.

The dialogs group (`PASEO_CAPTURE_HARNESS_GROUP=dialogs`) replaces `dialog.showMessageBox` with a
recorder for its run, wires guests and popups the way `main.ts` does, and checks that an idle
tab's and a popup's alert, confirm, and prompt are answered by Daseo with no native box or window
sheet; that an agent click's confirm comes back as `openDialog` within a second and
`handle_dialog` accept and Cancel reach the page; that `dialog: "accept"` answers in the same call;
that prompt text reaches the page; that a held confirm makes snapshot answer at once while navigate
still runs; that an agent leaves a page with a live `beforeunload`; that `Notification.permission`
is `denied`; that `disableDialogs` alone keeps Electron from showing a box; and that a held confirm
nobody answers is dismissed after 60 s (set `PASEO_CAPTURE_HARNESS_SKIP_UNANSWERED=1` to skip that
minute). Electron gives the page sticky activation only through real input or a user-gesture
script; the beforeunload check clicks with the agent's own background click.

The frames-network group (`PASEO_CAPTURE_HARNESS_GROUP=frames-network`) serves a page with a
same-origin and a cross-origin iframe from two local ports. It runs the compiled automation
service against the guest and checks that the snapshot nests the same-origin frame's content
with refs while the cross-origin frame stays one node; that background and trusted clicks,
fill, type, upload, wait, and evaluate reach the inner elements (the trusted click must land at
the frame's border and padding offset); and that `browser_network` captures a same-origin
`fetch` with its bodies, credentials redacted. It then exports a capture (delta 99): a page that
sets an HttpOnly cookie calls a bearer-authenticated JSON API (a list, an item twice, a login POST
the server echoes, a 302, a 404) and a WebSocket echo, navigates away, and the exported
`out/network-export.har` must hold the API bodies and response headers, two pages, the frames,
`Bearer <redacted-N>`, and none of the cookie, token, or password, with mode 0600. Last it captures
150 API requests and prints the CDP body copies per request and the main-process heap the capture
holds. The fixture reads every response body: a fetch whose body nobody reads never gets
`loadingFinished`, and a navigation leaves it in flight.

The debugging group (`PASEO_CAPTURE_HARNESS_GROUP=debugging`) serves a page under a
`script-src` nonce CSP with `require-trusted-types-for 'script'` and checks the delta 35
tools in real Chromium: `browser_evaluate` runs there; `browser_logs` marks the previous
page's messages and filters by level; scoped and interactive snapshots; an element
screenshot sized to the element; `browser_styles` ordering (style attribute, then `#id`, then
`.class tag`) with the stylesheet URL and line; and `browser_resize` mobile emulation reaching
the request's User-Agent header, `(pointer: coarse)`, `(hover: none)`, touch, DPR 3, and
`navigator.userAgentData`, then clearing. CDP lists each declaration of a styled rule twice
(as written, with a range, and as parsed, without), which only shows against real Chromium.

The click-effect group (`PASEO_CAPTURE_HARNESS_GROUP=click-effect`) serves a page whose dialog
mounts at opacity 0 and fades in, a button that does nothing, an `aria-expanded` toggle, a form
posting to a route that answers after 1.5 s, a link, and a form whose submit the page cancels. It
checks the effect line `browser_click` and Enter return (delta 100), that an immediate find and
snapshot show the fading dialog as `appearing=true`, and the background click's event order, and
records each command's duration in `click-effect-results.json`. To show the checks failing before
a change, compile the committed sources elsewhere and point
`PASEO_CAPTURE_HARNESS_DIST_DIR` at that `dist`; without it the harness runs this checkout's.

The automation group uses a real guest webview to verify the page-side ref contract:
ARIA-like snapshot text includes headings, static text, and controls; refs survive
`pushState` when the element still matches; same-URL rerenders stale old refs; and a
file-input ref can be resolved to a CDP backend node id for upload. It also verifies
page-context evaluation, including passing a resolved ref element as the function argument.
The background-input regression executes the compiled automation service against the real
parked guest. It asserts the host composer's active element, value, blur count, and input count,
then verifies the browser target received click and text. Keyboard containment runs last because
the host-composer sentinel intentionally leaves native focus in the host. It reuses an existing
fixture button: adding a test-only control changes the inline fixture geometry exercised by the
earlier actionability checks.

On macOS the harness process must set `app.setActivationPolicy("accessory")` and
hide the Dock icon before creating any window. `showInactive()` only prevents window
focus; a normal Electron app launch can still activate the app and steal focus.
Harness windows are then created hidden, positioned in a screen corner, skipped from
the taskbar where Electron supports it, and revealed with `showInactive()` from
`ready-to-show`. Do not replace this with `show()`, `focus()`, or `app.focus()`:
the compositor only needs visible inactive windows, and harness runs must not steal
focus from the person using the machine.

The harness writes PNG evidence and `results.json` to:

```text
packages/desktop/capture-harness/out/
```

A passing run prints `PASS` lines for the production P1 attach-off parking state,
including fresh, settled, 75-second soak, multi-tab, viewport, and full-page checks. The
PNG sizes may be device-pixel scaled; on a Retina display the 1280x800 logical viewport
is usually saved as 2560x1600.

## Mechanism

Electron captures copy from the guest web contents' compositor surface. A resident
webview parked with `display:none`, offscreen coordinates, or `opacity:0` can lose its
copyable surface. Each production webview keeps one permanent body-level surface. Presenting
or parking changes that surface's geometry without reparenting the webview. The parking state
uses `left:0`, `top:0`, `width:1px`, `height:1px`, `overflow:hidden`, `opacity:1`, and
`pointer-events:none`. The webview stays at its resolved logical viewport, defaulting to
1280x800 before first presentation, with `display:inline-flex` at `left:0`, `top:0`.
Presentation resolves responsive guests to the pane's exact pixel dimensions after the surface
has visible bounds. Do not apply percentage guest sizing against the parked surface: Electron
exposes the 1x1 parking geometry as a real guest resize before expanding it again.

The permanent browser host and `overlay-root` are explicit sibling paint planes. The browser
plane stays below the overlay plane regardless of body insertion order; menus keep their relative
layering inside `overlay-root`. Activating a presented browser also focuses its registered guest
`WebContents` in main so macOS assigns keyboard first-responder ownership to the page.

There is no host-renderer parking handshake. Main tracks every guest in the tab lifecycle
(`packages/desktop/src/features/browser-webviews/lifecycle.ts`): a guest starts active with
background throttling off, throttles after 2 unused minutes, and freezes after 15. A screenshot
holds its tab active for the whole capture, so a throttled or frozen tab wakes first; it then
waits up to one second for two animation frames, uses the shared serialized queue, invalidates
before each attempt, and retries known first-frame failures, all inside one deadline. Viewport
screenshots retain the 5-second budget and use `capturePage({ stayHidden:false })`.

CDP pointer presses on an embedded guest move host DOM focus into the `<webview>`, even when its
parked surface has `pointer-events:none`. CDP `Input.insertText` follows Chromium's active focus
chain and can therefore write into a host textarea instead of the requested guest. Main considers
pointer input trusted only when the target browser owns both logical and Electron focus. Background
pointer actions use page-local user-gesture execution, text uses the target
`WebContents.insertText`, and key input stays target-contained with `skipIfUnhandled`.

Electron guest `captureBeyondViewport` repeats the current compositor viewport below the fold,
so full-page capture uses a bounded 30-second scroll-and-stitch path. It verifies the scroll before
and after every CDP tile, retries changing layouts up to three passes, renders fixed elements only
in the first viewport, temporarily removes sticky positioning, and restores page state afterward.
Captures are capped at 128 tiles and a 128 MiB raw bitmap; timeout aborts the active capture instead
of leaving work in the CDP queue. The harness checks the distinct bottom marker so a correctly
sized repeated viewport cannot pass.
