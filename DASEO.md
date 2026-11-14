# Daseo

**Daseo** (= _Do all, seek eternal only_ · initials **dgk** + Paseo) is David-Daniel Kang's
personal fork of [Paseo](https://github.com/getpaseo/paseo), built and shipped as his own
Mac app and Android APK. Logo: **DΛ**.

This file is the fork's source of truth. Daseo is an independent product, not a tracking
fork: since 2026-09-06 it no longer merges upstream `main` wholesale. When asked to "apply
Paseo updates to Daseo", review upstream commits individually and adopt only those that
solve a real Daseo problem without a trade-off (see "Upstream adoption policy" below), keep
every delta listed below working, rebuild each changed platform from the task commit, and
update this file if the delta set or the adoption log changes.

## Identity

|              | Paseo (upstream)                 | Daseo (this fork)                                                       |
| ------------ | -------------------------------- | ----------------------------------------------------------------------- |
| Repo         | `getpaseo/paseo`                 | `dgk-dev/daseo`, branch `main`                                          |
| Mac app      | Paseo.app (App Store / releases) | `/Applications/Daseo.app`, stable locally signed Daseo SemVer build     |
| Android      | `sh.paseo` (Play)                | `sh.paseo.dgk` ("Daseo"), matching product SemVer, parallel-installable |
| Display name | Paseo                            | Daseo (display only)                                                    |

**Deliberately unchanged** to stay upstream-compatible and preserve state: internal
identifiers (`productName`, Electron userData path, `~/.paseo`, `paseo` CLI, Mac bundle IDs,
URL scheme `paseo://`), all i18n strings, and the design-system structure. The Android
personal variant is the deliberate exception: it uses `sh.paseo.dgk` for parallel install.

## Fork deltas (must survive upstream merges)

1. **Remote browser streaming to mobile** — daemon `BrowserStreamHub` fans CDP screencast
   frames (binary opcode `0x20`) from the Electron browser host to mobile watchers over the
   relay; tap/two-axis-scroll/text/key/navigate inputs map back through trusted CDP. CDP ACKs
   cap the producer at the mobile-requested frame interval, server backpressure preserves only
   the latest frame, and static/navigation fallback captures prevent a blank or stale first
   paint. Each pane has an independent viewer ID and workspace-scoped control path; hidden or
   backgrounded panes unsubscribe, frame sequence rejects stale delivery, and failed startup
   uses bounded backoff before exposing a manual Retry control while retaining the last frame.
   The phone draws frames with expo-image so the shown frame stays until the next is decoded
   (delta 90). Feature flag `serverInfo.features.browserRemoteStream`. Key files:
   `packages/protocol/src/binary-frames/browser-stream.ts`,
   `packages/server/src/server/browser-tools/stream-hub.ts`,
   `packages/desktop/src/features/browser-automation/{screencast,stream-input}.ts`,
   `packages/app/src/desktop/browser/pane/index.tsx`, `remote-stream-watch.ts`,
   `remote-stream-frame.tsx`, and `remote-stream-retry.ts` (native viewer).
2. **Bidirectional browser workspace sync** — `browser.remote.open/list/close` RPCs let
   phones open real desktop tabs, continuously discover tabs created by Mac UI or agent
   browser tools, refresh URL/title/navigation/loading state, and close the authoritative
   Mac tab. The desktop workspace layout—not only currently mounted webviews—is the tab-list
   SSOT; listing answers from the persisted layout and browser store without starting any guest,
   and the first command aimed at a tab with no guest creates that one guest and waits for its
   registration (delta 33).
   Newly discovered browsers sit directly after the current mobile tab in host order. Desktop
   active-browser state seeds an otherwise empty mobile selection, but subsequent mobile tab
   choices remain local so background refresh cannot pull an open agent back to a browser. Mobile
   viewers reconcile on focus and every two seconds; transient disconnects or host hydration
   preserve local viewers. Workspace
   header ⋯ menu, tabs-row ∨ menu, and pinned globe launcher expose `New browser` when the feature
   flag is on. Key files: `packages/app/src/screens/workspace/workspace-screen.tsx`,
   `packages/app/src/desktop/browser/automation/handler.ts`, `resident-webviews.ts`, and
   `remote-tabs-sync.ts`.
3. **Rebranding (display-only)** — the sole DΛ geometry source is
   `packages/app/assets/brand/daseo-mark.svg`; `npm run brand:generate` deterministically owns
   the generated React Native path module plus native, PWA/status, notification, splash, macOS,
   Linux, and Windows image derivatives. `npm run brand:check`, the pre-commit hook, and desktop
   build reject manual drift. Android personal variant name "Daseo" (`packages/app/app.config.js`),
   Mac window-title display
   name (`packages/desktop/src/main.ts`), quiet theme-derived project fallback icons in
   `packages/app/src/components/project-icon-view.tsx` that reserve color for operational
   status, square graphite user prompt panels in `packages/app/src/components/message.tsx`, and
   a Composer with a compact monochrome stop control in `packages/app/src/composer/` (a top rule
   only since delta 53)
   that preserves shared layout, touch targets, and readability. Packaging uses the safe post-build Info.plist patch at
   `packages/desktop/scripts/daseo-app-package.mjs` plus the outer `Daseo.app` rename. The patch
   keeps `CFBundleName=Paseo`; Electron uses that internal product name to locate the
   unchanged `Paseo Helper.app` bundles.
4. **Daseo theme** — monotone graphite dark variant registered in
   `packages/app/src/styles/theme.ts` (`darkDaseoTheme`) and selectable in appearance
   settings on desktop and mobile.
5. **Provider-neutral completed-turn disclosure** — completed turns show the user prompt and
   every provider-authored `final_answer`, while thought/tool/todo/activity/compaction and explicit
   `commentary` fold behind one expandable "Worked for …" row. The optional phase follows Codex's
   official `commentary | final_answer` contract through Pi/Codex live events, history, coalescing,
   protocol validation, canonical projection, replica cache, and rendering. Providers that never
   sign a phase (Claude through the Pi bridge) get `final_answer` derived from Pi's `stop`
   reason on the completed message, so an answer the model finished on its own stays visible
   when a queued follow-up (background fetch notification, steer) wakes it again in the same
   turn; `toolUse` narration stays phase-less and folds. Fully phase-less streams retain the
   legacy final-suffix fallback. Expansion restores the original stream items and order
   losslessly. Claude, Codex/ChatGPT, Grok-through-Pi, OpenCode, and other providers share the same
   UI contract; `blockGroupId` is used when available but never required. Active,
   partial/detached, permission-blocked, failed, and canceled turns stay open, while error and
   failed/canceled tool rows remain visible. Terminal outcomes survive canonical hydration, and
   provider message identity preserves manual expansion across renderer-row changes. A summary row
   never hides more of the answer than it leaves visible: a folded assistant answer that is
   substantive on its own and longer than everything still on screen is revealed. The answer is
   weighed as one logical message (its `blockGroupId` rows, or adjacent rows), because live
   streaming promotes each markdown block to its own row and every paragraph of a long answer can
   sit under the threshold; hydrated history merges them back. That guard exists
   because phase metadata is only as good as its source — codex gets commentary/final_answer from
   the model, while pi derives it from stopReason, so an answer written just before one last tool
   call is untagged and would otherwise fold behind a two-line sign-off. The projection
   also spans the settled/live buffer boundary. Key files: `packages/protocol/src/agent-types.ts`,
   `packages/server/src/server/agent/providers/{codex-app-server-agent,pi/agent}.ts`,
   `packages/app/src/agent-stream/collapsed-work.ts`, `view.tsx`, `collapsed-work-row.tsx`, and
   `packages/app/src/types/stream.ts`.
6. **Independent Android push notifications** — the personal Android variant gets a native
   FCM device token instead of depending on upstream's Expo project; the Mac daemon sends
   agent-finished and permission-request notifications through FCM HTTP v1. Key files:
   `packages/app/src/push-notifications/internal/subscriptions.ts`,
   `packages/server/src/server/push/fcm-service.ts`, and `packages/app/app.config.js`.
   Runtime credentials are intentionally outside git: Android config at
   `packages/app/.secrets/google-services.personal.json`; sender service account at
   `~/.paseo/daseo-fcm-service-account.json` (mode 0600). Firebase project: `daseo-push`.
7. **Model/abort robustness patches** — replacement-model catalog probe skip, aborted-turn
   cancellation normalization (`packages/server/src/server/agent/provider-registry.ts`,
   `providers/pi/agent.ts`), send-gate fix and native combobox placement
   (`packages/app/src/provider-selection/provider-selection.ts`,
   `components/ui/combobox.tsx`).
8. **Fold- and CJK-safe mobile UX** — unfolded Fold/tablet sidebar controls stay above the
   Android navigation inset (`packages/app/src/components/left-sidebar.tsx`), while Markdown
   headings use token-proportional line heights plus full-width wrapping containers and a CJK
   keep-all leaf policy, so multi-line Korean and large-font text measures its complete height
   instead of clipping (`packages/app/src/styles/markdown-styles.ts` and
   `components/markdown/heading-style.ts`).
9. **Project-scoped empty workspace auto-create** — `/new` launched from a project creates an
   empty local workspace immediately, allowing browser/terminal use before an agent starts;
   global, worktree, unsupported-daemon, and failure paths retain the intro fallback. Archiving
   the active workspace never enters this creation path: Daseo selects an existing workspace in
   the same project or leaves the main pane empty when none remains. Key files:
   `packages/app/src/screens/new-workspace-auto-create.ts`, `new-workspace-screen.tsx`, and
   `packages/app/src/utils/workspace-archive-navigation.ts`.
10. **MCP era-negotiation compatibility** — MCP 2.x Pi clients probe with the forward-dated
    `server/discover` method before falling back to the bundled MCP 1.x SDK. Daseo recognizes
    that exact probe and returns the expected legacy signal without logging it as a daemon error;
    forward-dated `initialize` requests can still negotiate the daemon's latest supported version,
    while unknown established requests remain strict. Key files:
    `packages/server/src/server/agent-mcp-protocol.ts` and `bootstrap.ts`.
11. **Relay close-race hardening** — when a superseded mobile relay socket enters `CLOSING`
    between the send readiness check and callback, its final frame is dropped as normal disconnect
    control flow instead of surfacing a false daemon `Client error`. Failures on sockets that are
    still open remain strict. Key file: `packages/server/src/server/relay-transport.ts`.
12. **Provider-native active-turn steering** — ordinary prompts sent while a supported agent is
    running join that exact turn instead of canceling and replacing it. Codex uses `turn/steer`
    with the native expected turn id, Pi uses RPC `streamingBehavior: "steer"` and waits for
    `agent_settled`, and Claude pushes a priority-`next` SDK user message. Capability negotiation
    keeps unsupported or older providers on the queue/replacement fallback without model-specific
    branches. An active-turn command is durably admitted before the daemon waits for native steering,
    so Pi compaction never holds the client RPC open. Desktop and mobile keep every durably admitted
    prompt visible even if client liveness misclassified it as non-steering, reconcile receipts with
    bounded backoff, and reject interrupted receipts after daemon restart unless canonical history
    proves delivery. Pi cannot settle a turn while native steering acknowledgement is pending, and a
    terminal event racing after provider acknowledgement cannot discard the accepted prompt. Explicit
    queued messages and terminal rejections retain their recovery controls. Steering identity survives
    optimistic UI, canonical echo, cache, history, and completed-work folding, with a subtle
    user-message marker. Key files:
    `packages/server/src/server/{session,agent/agent-prompt,agent/agent-manager}.ts`,
    `packages/server/src/server/agent/providers/{codex-app-server-agent,claude/agent,pi/agent}.ts`,
    `packages/app/src/composer/`, `packages/app/src/runtime/host-runtime.ts`, and
    `packages/app/src/types/stream.ts`.
13. **Stable local macOS signing** — Mac builds must be signed with the login-keychain identity
    `Daseo Local Code Signing`, whose stable designated requirement preserves Accessibility,
    Screen Recording, and Full Disk Access grants across local rebuilds. The private key and trust
    record stay outside git. `packages/desktop/scripts/daseo-code-sign.mjs` fails closed when the
    identity is absent; never substitute ad-hoc (`codesign --sign -`) signing because its changing
    cdhash makes macOS treat every Daseo update as a new privacy subject.
14. **Workspace-owned in-browser popups** — Electron adopts Chromium's original popup
    `WebContents` into a workspace/browser target graph instead of showing an OS child window.
    OAuth, POST, named-window reuse, direct opener relationships, recursive popups,
    `postMessage`, and `window.close()` retain browser semantics. Background and agent-created
    targets stay in non-focusable native parking windows with paintable viewports. That window
    gives no frames of its own once a view was hidden, and Electron's "throttling off" broke the
    OAuth return to the opener's site, so a parked popup renders through a DevTools focus emulation
    hold while it is awake and never has background throttling turned off (delta 107); users see them
    inside the opener browser, while agents and mobile clients can snapshot, input, debug, stream,
    resize, or close each target by its own browser id. User focus is authoritative: Chromium
    navigation autofocus is disabled for embedded targets, inactive workspaces cannot advertise an
    active browser, only a trusted pointer in the visible interactive pane may claim physical browser
    focus, and hidden retained overlays neither trap nor restore focus over a newer input. Browser
    automation treats physical focus as a main-process lease: CDP pointer presses are allowed only
    when the target is both the workspace's active browser and Electron's focused `WebContents`.
    Background clicks and drags use page-local semantic input, text uses the target
    `WebContents.insertText`, and keys use contained target input, so another workspace cannot blur
    or write into the host Composer. Popup visibility is double-gated: the renderer reports the
    foreground workspace through `setWorkspaceActiveBrowser` (`isForeground`), and the main process
    owns a per-window `unknown | none | workspace` state. Unknown remains fail-open for old renderers;
    explicit none parks every popup; a workspace owner parks all other workspaces. Denied presentation
    intent is retained and reconciled when its workspace becomes foreground, so IPC ordering cannot
    leave a selected popup blank after a workspace switch. Stale false reports cannot override a newer
    owner, and route teardown reports explicit none even when no final background render occurs. Key files:
    `packages/desktop/src/features/browser-webviews/{popup-targets,focus-policy}.ts`,
    `packages/desktop/src/features/browser-automation/{service,focus-isolated-input}.ts`,
    `packages/app/src/desktop/browser/{popup-targets,remote-popup-targets,focus-policy}.ts`, and
    `packages/desktop/e2e/browser-tabs.e2e.mjs`.
15. **Image-safe composer delivery** — Mac paste reads Electron's native clipboard image as a
    canonical PNG instead of trusting one Chromium pasteboard flavor, while browser-file fallback
    and native mobile paste remain available. The composer stays non-sendable until asynchronous
    persistence finishes; multi-image persistence rolls back atomically; unreadable, empty, or
    provider-incompatible image bytes fail the send and restore the draft instead of silently
    reaching an agent as text-only. Canonical user rows retain structured context attachments and
    image counts, so authoritative reloads keep attachment-only prompts visible; image bytes remain
    client-local and hydrate as an unavailable-preview placeholder. Desktop selection offers the four
    portable provider formats, and native pick/paste converts other raster formats to PNG. Key files:
    `packages/app/src/{attachments,composer,utils/image-attachments-from-files.ts}` and
    `packages/desktop/src/features/clipboard-image.ts`.
16. **Fork-owned update provenance** — Daseo never follows official Paseo npm or GitHub update
    channels. The Mac packaging step writes `daseo-distribution.json` with the exact source commit,
    product version, and Mac build number, removes `app-update.yml`, and the packaged runtime disables
    Electron auto-update and quit-time installation. The marker is propagated to the bundled daemon,
    which rejects live npm self-update. Daseo upgrades use the stable local signing identity, external
    artifact hashes, an idle gate, and explicit activation approval.

17. **Pi extension-turn lifecycle** — Pi extensions may wake the agent without a Paseo prompt
    (background web-fetch completions send `triggerTurn` messages) and may keep working after
    `agent_end` (auto-compaction, queued continuations). Every run, including an autonomous one,
    receives a stable provider turn id, so steering, process exit, cancellation, usage, and terminal
    events stay correlated. `agent_settled` is accepted only after the same run's `agent_end` and an
    idle runtime state; the legacy/lost-event fallback also verifies runtime idleness, compaction,
    pending messages, and a quiescence window instead of trusting a timer. Compaction end resumes the
    fallback, and unrelated custom messages cannot complete a user prompt preflight. Key file:
    `packages/server/src/server/agent/providers/pi/agent.ts`.
18. **Native-owned Composer replacement** — Android keeps the IME-friendly uncontrolled Composer,
    but application replacements use the PasteInput Fabric component's event-count-aware native
    command rather than raw `setNativeProps`. Sends, queue clears, autocomplete, restore, and draft
    hydration advance a replacement revision; an exact late pre-replacement IME event is rejected and
    retried after the native event count commits. Composer editing remains disabled until Zustand's
    global draft hydration merge finishes, preventing a cold-start persisted draft from restoring
    stale sent text. Key files: `packages/app/src/components/ui/text-input/`,
    `packages/app/src/composer/`, `packages/app/src/stores/draft-store/`, and
    `patches/@mattermost+react-native-paste-input+2.0.1.patch`.
19. **Provider-gated fast mode control** — the Composer renders a direct lightning toggle on desktop
    and mobile whenever the selected provider/model advertises `fast_mode`; enabled uses a filled
    bolt and disabled uses a slashed bolt in the same monochrome treatment, so state never depends
    on color alone. Native Codex and Claude keep their provider-owned
    implementations. Pi discovers optional model features through the generated integration bridge,
    so Pi Codex can control its request-local priority tier without exposing a false toggle for Fable,
    Grok, DeepSeek, or other models that do not support it. Key files:
    `packages/app/src/{agent-controls,composer/agent-controls}/`,
    `packages/server/src/server/agent/providers/pi/agent.ts`, and the local Pi feature host.
20. **Pi model-selection SSOT plus Daseo launch policy** — Pi runtime discovery remains the model
    capability SSOT, while `~/.pi/agent/settings.json` `enabledModels` is the single visibility,
    ordering, and per-model thinking-default source shared by standalone Pi and Daseo. A temporary
    catalog extension publishes Pi's effective `ctx.scopedModels` after global/project settings and
    trust are resolved; Daseo projects that exact scope onto runtime-discovered capability metadata,
    filters each model to provider-native effort values, removes duplicate aliases, and uses Pi's
    active runtime model as the default. Daseo no longer carries a duplicate model list, model
    default, or thinking map. Generic `selectionPolicy` remains only for product behavior
    such as ignoring sticky preferences, applying each selected model's default effort in new and
    live sessions, and starting Sol Fast off; explicit drafts, resume data, and profiles still win.
    Key files:
    `packages/server/src/server/agent/providers/pi/agent.ts`,
    `packages/app/src/provider-selection/{provider-selection-policy,resolve-agent-form}.ts`, and
    `packages/app/src/hooks/use-draft-agent-features.ts`.
21. **PC-keyboard-aware Composer focus** — macOS uses `Cmd+L` as the primary shortcut, so a PC
    keyboard's physical `Win+L` focuses the Composer when Daseo is frontmost; the local Karabiner
    lock-screen rule explicitly exempts Daseo. `Ctrl+L` remains a Mac/Windows fallback, and both
    chords are disabled while a terminal owns focus to preserve terminal clear-screen behavior.
    The legacy binding id stays stable so existing user overrides survive the migration. Key file:
    `packages/app/src/keyboard/keyboard-shortcuts.ts`.
22. **Model-scoped acknowledged features** — feature preferences are stored by model rather than as
    provider-wide flat state. Live toggles render an optimistic value, reject repeated input while
    pending, persist only after the daemon accepts the runtime mutation, and roll back to canonical
    agent state on failure. Model changes prune unavailable session features; Pi resets Sol Fast to
    its policy default before entering Claude, so no latent Fast value crosses that capability
    boundary. Key files: `packages/app/src/{create-agent-preferences,hooks}/`,
    `packages/app/src/composer/agent-controls/`, and
    `packages/server/src/server/agent/{agent-manager,providers/pi/agent}.ts`.
23. **`/btw` side questions** — `/btw <question>` in the Composer never reaches the agent: it opens
    an adaptive sheet (bottom sheet on phones, card on desktop) whose answer comes from the agent's
    current conversation, never enters its timeline, and does not interrupt a running turn. The
    thread lives in client memory per agent; Clear also clears the host's replay copy, and
    "Continue in a fork" forks the agent into a tab with the exchange pre-filled. The daemon RPC
    `agent.side_question.request/response` (gated by `serverInfo.features.sideQuestion`) reaches Pi
    through the internal `paseo_side_question` extension command, which answers in the background
    because Pi acknowledges a command only when its handler returns. The model call belongs to
    pi-local's side-question extension (`ddgk.pi.side-question-host.v1`): Claude models go to
    pi-claude-bridge's native Claude Code side question (cache-safe, no tools), every other model
    replays the last provider transcript under the same prompt-cache key. Only Pi agents answer;
    other providers report that they do not support side questions. Key files:
    `packages/app/src/side-question/`, `packages/app/src/composer/index.tsx`,
    `packages/app/src/panels/agent-panel.tsx`, `packages/server/src/server/session.ts`, and
    `packages/server/src/server/agent/providers/pi/agent.ts`.
24. **Agent browser-tool accuracy** — from a 2026-09-28 audit of 32,064 browser calls over 60 days
    against Playwright MCP, Chrome DevTools MCP, and agent-browser. `fill`/`select` write through
    the prototype's native `value` setter so React-controlled fields update framework state (a
    direct assignment reported success while React kept the old value). The actionability hit
    test accepts the element's shadow host, ancestors, and associated label (custom checkboxes and
    web components no longer time out as "covered"), refuses clamped points outside the element,
    and names the covering element (`covered by <div#overlay "Cookie banner">`). Host
    `browser_timeout` reasons reach the agent instead of a generic "browser did not respond". The
    ARIA snapshot walks open shadow roots and slots, merges adjacent text runs, and drops a lone
    text child that repeats its node's name. Console levels are named (`error`, not `3`), network
    entries carry `responseStatus`. `browser_wait` pauses on a lone `timeoutMs` and clamps it to
    30s, `browser_scroll` defaults a missing axis to 0, `browser_upload` accepts one path string,
    `browser_logs` clamps `maxEntries`. The Pi MCP config marks the `paseo` server as
    `lifecycle: "eager"` because its per-agent URL never matches pi-mcp-adapter's metadata cache,
    so the lazy default showed "configured but not connected" in 213 sessions and idled out after
    10 minutes. The merged base is `~/.pi/agent/mcp-adapter.json` since pi-mcp-adapter 3.0 (Pi
    0.99's built-in MCP, disabled here, owns `mcp.json`), with `mcp.json` as the fallback. Key files: the `packages/desktop/src/features/browser-automation/` modules
    `actionability`, `aria-snapshot-script`, `snapshot-engine`, `ipc`, and `service`;
    `packages/server/src/server/browser-tools/tools.ts` and `broker.ts`; and
    `packages/server/src/server/agent/providers/pi/agent.ts`. Second pass (0.5.35): snapshot refs
    stay attached to their element for the document's life instead of renumbering from `@e1`, so a
    ref from an older snapshot can no longer hit a same-fingerprint neighbour; `browser_evaluate`
    returns at once when a main-frame navigation destroys the page function (it used to hang 15s
    into a generic timeout) and names a slow function at 14s; `fill` on contenteditable editors
    selects the contents and replaces them with trusted input; `browser_wait` text also matches
    inside open shadow roots; `browser_upload` follows a label's control or the single file input
    inside a button or dropzone; aborted navigations report where the tab ended up; and
    `browser_screenshot` takes an optional `savePath`. Audit pass (0.5.36): adjacent text merges
    only across inline markup, never across block elements (list rows stayed one line in 0.5.35);
    an ancestor at the click point blocks only input delivered at the point (user-focused trusted
    clicks, hover, drag), because focus-isolated events go to the element itself; blocker text is
    shown only when short; contenteditable `fill("")` clears through trusted input; upload also
    finds the single file input inside a label whose control is a button; `savePath` expands `~/`
    and refuses a relative path without a cwd.
25. **Quiet runtime metrics log** — the 30-second `ws_runtime_metrics` window logs at `debug` unless
    it shows trouble: any rejected or unroutable message, 3 or more socket disconnects, a request or
    event-loop stall at the `ws_slow_request` threshold (500 ms), or the final flush at shutdown.
    Upstream logs every window at `info`, which was 93% of daemon log bytes and left about five days
    of history in 10 MB × 5 rotation; in the 2026-09-26~29 logs 1.8% of windows would stay at
    `info`. The in-memory snapshot behind the diagnostics RPC still updates every window. Key file:
    `packages/server/src/server/websocket-server.ts` (`isRuntimeMetricsWindowAnomalous`). Takes
    effect with the next release and daemon restart.
26. **Browser harness details from the Aside comparison** — the trade-off-free parts of a
    2026-09-29 comparison with Aside's browser agent, each from a live measurement:
    - (Reverted by delta 81.) The browser profile session sent a plain Chrome user agent with the
      `Paseo/<version>` and `Electron/<version>` tokens removed; that is what made Cloudflare
      Turnstile loop on 600010. The session's Accept-Language and client-hint headers (delta 65)
      are still set right after `app.whenReady()`.
    - Snapshots mark `focused=true` on the element keyboard input goes to (followed into open
      shadow roots) and `disabled=true` on disabled controls, which still get no ref, so the agent
      sees why a button has none. Key file: `aria-snapshot-script.ts`.
    - A tab-scoped request that is about to time out on a tab that is still loading says so:
      `Tab <id> has been loading <N>s (url: …). The page has not finished loading; …`. Electron's
      `executeJavaScript` waits for the load to stop, so one stuck load (a Cafe24 admin tab loading
      for over 3 minutes) timed out every tab-scoped tool with "did not respond". One second
      before its timeout the broker asks that tab's host through `list_tabs`, which now carries
      `loadingForMs` (and the URL being loaded when none has committed), and `browser_list_tabs`
      shows `loading=<N>s`. Key files: `packages/server/src/server/browser-tools/broker.ts`,
      `packages/desktop/src/features/browser-automation/load-tracker.ts`, and the optional
      `loadingForMs` in `packages/protocol/src/browser-automation/rpc-schemas.ts`.
    - Merged inline text gets a space only where the page has whitespace between the runs. The
      capture records leading/trailing whitespace per text run before trimming, and a
      whitespace-only run separates its neighbours; a page that wraps each character in a span
      (example.com) rendered as `T h i s d o m a i n` before. Key files:
      `aria-snapshot-script.ts` and `snapshot-engine.ts`, tested by running the real capture
      script in jsdom (`aria-snapshot-script.test.ts`).
27. **Same-origin iframes in snapshots and actions** — in 60 days agents reached into
    `iframe.contentDocument` 347 times through `evaluate`/`mcpScript` (Cafe24 cart drawer and
    purchase frames), because the snapshot only counted iframes. The snapshot script now walks a
    same-origin frame's document in place of the `<iframe>` element's children, under the same
    global 1500-node / 500-ref caps, and its refs live in the top window's one registry, so every
    ref tool (click, fill, type, select, hover, drag, upload, keypress, evaluate) works unchanged;
    `browser_wait` text also searches those frames. A frame the page cannot reach renders as one
    node with `cross-origin=true src=…`; one still parsing shows `loading=true`. The match between
    a frame and its element is exact because the walk goes through `contentDocument`: it is null
    exactly when page script is refused (cross-origin or sandboxed), and no name/src/frameToken
    guess is involved (Electron's per-frame `executeJavaScript` was the alternative). Frame nodes
    come from another JS realm, so the scripts use `nodeType` checks and the element's own window
    for styles and events instead of `instanceof`. Actionability returns `point` in the tab
    viewport (for trusted CDP input) and `framePoint` in the element's frame (for focus-isolated
    events), adds each frame's border, padding, and scale on the way out, hit-tests the frame
    element at every level, and treats a frame that is still sliding in as moving. A ref whose
    frame navigated or was removed is stale. Key files: the
    `packages/desktop/src/features/browser-automation/` modules `aria-snapshot-script`,
    `actionability`, `focus-isolated-input`, `snapshot-engine`, and `service`; real-Electron
    coverage in the capture harness `frames-network` group.
28. **`browser_network` request capture** — agents hooked `fetch`/`XMLHttpRequest` by hand 330
    times in 60 days to see a site's own API calls. The tool captures one tab's requests through
    the CDP Network domain: `start` enables it (clearing earlier entries), `list` returns completed
    requests oldest first with a `seq` cursor for `since` plus `urlIncludes`/`method`/
    `resourceType` filters, `stop` disables the domain. Idle tabs pay nothing. Bodies are fetched
    only when asked (`includeBodies`, `includeRequestBodies`): 64 KB per body, 256 KB of response
    bodies per list, binary and evicted bodies named instead of sent. Entries get their `seq` when
    they complete, so a cursor never skips a request that was pending during the previous list;
    the tab keeps the latest 500 (2,000 since delta 99). Request headers drop the ones the browser sets itself;
    `Cookie`, `Set-Cookie`, `Authorization`, and `Proxy-Authorization` values and password or
    one-time-code fields in JSON, form, and multipart bodies read `<redacted>`, so a login filled
    by the credential broker is not exposed through its POST. URL tokens and response bodies stay
    as they are because page script, and so `browser_evaluate`, can read them anyway. The capture
    rides the debugger session screencast, dialogs, and trusted input already share, never
    detaches it, and stops if the debugger detaches. Old apps do not advertise the `network`
    command, so the broker reports it unsupported there. Key files:
    `packages/desktop/src/features/browser-automation/network-capture.ts`, `ipc.ts`, `service.ts`;
    `packages/server/src/server/browser-tools/tools.ts`;
    `packages/protocol/src/browser-automation/rpc-schemas.ts` and `paseo-tool-call-detail.ts`.
29. **Background waits hold "finished"** — since 2026-09-30 pi-local's `wait_for` lets an agent
    register a wait (a command's exit or output lines, or a file), end its turn, and be woken later
    by an extension user message in the `<paseo-system>` envelope (the extension turn of delta 17).
    An agent that ends its turn to wait is not finished, so a delegated implementer no longer tells
    its parent "finished" while its build is still running. The Pi provider reads the count of
    waits that will still wake the agent from `wait_for`/`wait_status`/`wait_cancel` results
    (`details: { wait: true, pending }`) and from the wake envelope's first lines
    (`wait_for: <kind> <wait_id> <status> pending=<N>`, minimum over the lines), and a Pi process
    exit resets it to 0. The manager copies it to `ManagedAgent.pendingBackgroundWaits` (on the
    wire only as delta 30's `backgroundWaits`). While it is above 0, a running→idle
    transition sets no "finished" attention (so no push) and notify-on-finish stays quiet; the
    idle after the last wake turn, or the next state emission once the count is 0, delivers both.
    Errors and permission requests are unaffected, and `lifecycle` is never faked. The hold
    expires 3,660 s after the last registration (`wait_for`'s 3,600 s maximum plus a minute) with
    a `background_wait_hold_expired` warning. Key files:
    `packages/server/src/server/agent/providers/pi/agent.ts` (`readPiWaitToolSignal`,
    `readPiWaitEnvelopePending`), `agent-manager.ts` (`syncBackgroundWaits`,
    `checkAndSetAttention`), `agent-prompt.ts`, and the optional `AgentSession.backgroundWaits` in
    `agent-sdk-types.ts`. Takes effect with the next release and daemon restart.
30. **Background waits look busy, and their wake rows fold** — an agent that ended its turn to wait
    (delta 29) stays `idle`, so Daseo showed it idle, like an agent waiting for the user, and every
    wake arrived as a divider row that never folded. Now the snapshot and agent list item carry
    an optional `backgroundWaits: { pending, labels }` (labels = descriptions of the pending waits,
    newest first, at most 3; ledgered as an optional field older apps strip). The Pi provider keeps
    `wait_id → description` from `wait_for`'s create details (`description`) and drops an entry on
    `wait_cancel`'s `cancelled` ids, on a wake line that ends the wait (`exited`/`timed_out`, or a
    file wait's single `fired`; a command wait's `fired` is one matching line and keeps it), and
    when `pending` reaches 0; it never keeps more labels than `pending`. An expired hold (delta 29)
    omits the field. `deriveAgentStateBucket`/`getAgentStatusPriority` treat `idle` with
    `backgroundWaits.pending > 0` and no permission or error as `running`
    (`isAgentWaitingInBackground`); an unread "finished" does not block it, because delta 29
    sets none while waits are pending, so one seen then is stale (a subagent's interim report
    its lead already read stopped the sidebar spinner while the subagent waited on a build,
    2026-11-10), and it shows again once the waits are gone. So sidebar, tabs, workspace status, the subagent track, the
    command center, and agent sorting show it busy; lifecycle, composer, and queue semantics are
    unchanged. A wake (`<paseo-system>` whose first line is `wait_for: …`) parses as summary kind
    `wait` and renders as one compact line,
    `↳ 대기 완료 · <description> · 종료 N | 조건 일치 | 시간 초과` (info color; warning on
    timeout), still expandable to the full body. In the
    completed-turn projection it is neither a turn boundary nor visible: it folds with that turn's
    tool calls behind the summary row. It stays a real `user_message` in the canonical stream.
    Agent-finished and schedule rows are unchanged. The app shows agent state elsewhere only as
    dot, ring, and icon, so the waiting text lives in the conversation's bottom progress row: an
    idle agent with pending waits shows the spinner and `백그라운드 대기 중 · <newest label> +N`
    below the last answer's actions (`TurnFooter` `backgroundWait`). "Archive finished subagents"
    never counts or archives an idle managed subagent with pending waits, whatever its attention
    state (an old unread "finished" survives a later run). Key files: `packages/protocol/src/agent-state-bucket.ts`,
    `messages.ts` (`AgentBackgroundWaitsPayloadSchema`), `providers/pi/agent.ts`
    (`readPiWaitEnvelope`, `recordBackgroundWaits`), `agent-projections.ts`,
    `packages/app/src/agent-stream/system-notification.ts`, `system-notification-row.tsx`,
    `collapsed-work.ts`, `turn-footer.tsx`, `subagents/archive-finished.ts`. Takes effect with the
    next release and daemon restart.
31. **A wake that needs nothing never becomes the last message** — a wake can land after the
    agent's final answer (the Claude bridge injects it live only while a tool call is pending), and
    the woken turn ended on "No response requested." That line became the last message in the
    conversation, the push body, and a parent's `<agent-response>` for a held notify-on-finish
    (delta 29), in place of the real report (2026-10-01). pi-local's wake footer now asks for
    exactly `[wait noted]` when the wake needs nothing, and `wait_status` settles the completions
    it shows (`details.settled`, read like `wait_cancel`'s `cancelled`), so they do not wake at
    all. `isWaitNotedReply` and `lastAssistantRun` (`packages/protocol/src/wait-noted.ts`) skip
    that reply wherever the daemon picks the last assistant message (`agent-manager.ts`, both
    timeline stores), and `collapseCompletedWorkStream` drops it from the rendered stream, so the
    turn ends on the real answer followed by the one-line wake row. Matching is exact (backticks
    and a trailing period allowed); an answer that mentions the token renders normally. Takes
    effect with the next release and daemon restart.
    Activation also must not kill a real wait: `paseo ls --json` items carry
    `backgroundWaits` (pending count, 0 when none), and the activation script waits while any
    agent has one (90-minute cap), not on shell children of pi, which ordinary bash tool calls
    also are (`packages/cli/src/commands/agent/ls.ts`).
32. **Message times and response boundaries** — from a 2026-10-02 survey of how the open-source
    harnesses separate consecutive assistant messages and show time (Codex TUI, Claude Code
    2.1.285, OpenCode TUI and web, Gemini CLI, Pi, Goose desktop, Zed agent panel, Cline, Roo,
    Continue). Two answers in a row ran together as one block in Daseo, and the time was hidden
    behind hover. What the survey settled: a rule line is reserved for conversation events
    (compaction, interruption, a system prompt) in every GUI harness and none puts one between
    two assistant messages; a response is closed by its own metadata row (Goose: time under each
    message; OpenCode web: agent · model · duration on the last text part); the turn-end line
    shows duration and completion time together, always visible (Codex `Worked for 12s • 3:45 PM`,
    Claude Code `✻ Cooked for 2m 3s · done 3:45 PM`); per-message times are a setting named
    `showMessageTimestamps` in Claude Code (default off, "Stamp each message with its arrival
    time") and a `/timestamps` toggle in the OpenCode TUI (default hide), while the GUI harnesses
    show them always; and the time tiers (today → time, under a week → weekday + time, older →
    date + time) are the ones `formatMessageTimestamp` already had. Daseo now: (a) the turn
    footer reads `Worked for 12s · 3:45 PM` with both parts on screen, and keeps the time when the
    folded "Worked for …" row above the answer already shows the duration; (b) a completed response
    that another visible response follows in the same turn (a wait wake, a steer, a long answer
    kept visible beside its sign-off) closes with its own row — copy this message plus its arrival
    time — which is what separates the two (`StreamLayoutItem.responseFooter`, never set between
    blocks of one streamed message or across a tool row); (c) the user prompt's row (time,
    rewind/fork, copy) is on screen once the prompt is delivered. All three rows stay visible on
    desktop, web, and native alike, with no hover or tap reveal and no setting: David-Daniel asked
    on 2026-10-04 for the row to be always on, so the 0.5.40 "Message times" toggle, whose only
    job was choosing between always-on and hover, was removed (a stored value is ignored). Key
    files: `packages/app/src/agent-stream/{layout,turn-footer,view}.ts{,x}` and
    `packages/app/src/components/message.tsx` (`AssistantTurnFooter`, `AssistantResponseBlock`,
    `UserMessage`).

33. **Idle resources step down and wake before use** — from the 2026-10-04 RAM audit of this Mac
    (24 GB, swap 5.5 GB): 38 parked tab renderers held 7.25 GB and about two cores, 13 idle Pi
    processes 3.2 GB, and the daemon heap spiked to 2.6 GB on file-link lookups. The models are
    Edge sleeping tabs and VS Code's retained webviews for tabs, Codex app-server's thread unload
    and OpenCode's instance TTL for agents; Zed's leaked ACP processes are what happens without.
    (a) **Tab lifecycle.** Each browser guest is active (shown in a pane, held by a command,
    capture, or phone stream, or used in the last 2 minutes; background throttling off as before),
    then throttled after 2 unused minutes, then frozen after 15 through CDP
    `Page.setWebLifecycleState frozen`, which stops script and rendering but keeps memory, so page
    state survives and macOS compresses it. Every automation command, capture (including element
    capture), `stream_start`, and pane presentation wakes the tab first: lifecycle `active`, then
    throttling off, because an active page left throttled keeps 1 Hz timers. A phone stream holds
    its tab until `stream_stop`. Loading, audible, downloading, and network-capturing tabs
    throttle but never freeze. A frozen page's WebSockets drop and reconnect on wake, as in any
    frozen Chrome tab. Panes report presentation from `resident-webviews.ts`, the one place guests
    are presented and parked; popups report through their native view, and for a popup "throttling
    off" is its paint hold, never Electron's flag (delta 107). Desktop setting file
    `browser.suspendIdleTabs: false` restores always-active tabs. Discarding tabs (loses state) is
    not done. (b) **Listing starts no guests** (delta 2). (c) **Bounded directory suggestions.**
    Discovery charges a read budget of 60,000 directory entries, cache hits included; a directory
    over 5,000 entries contributes no children; a search rooted at home skips `Library`,
    `Applications`, `Movies`, `Music`, and `Pictures` (browsing `~` and explicit paths still
    reach them). Each session runs one search at a time; a typeahead search supersedes the
    previous one of the same picker, while file-link (suffix) lookups are never cancelled, since
    each click names its own file. Hover prefetch waits for a 300 ms rest and skips while another
    lookup runs. The daemon logs `daemon_heap_high` when heap passes 1 GB. Home-root lookup: 2.7 s
    and 613 MB heap before, 0.65 s and 106 MB after; 8 concurrent lookups ran out of heap before
    and peak at 555 MB after. (d) **Idle agents unload.** After 60 quiet minutes
    (`~/.paseo/config.json` `agents.idleUnloadMinutes`, read at daemon start, 0 turns it off) an
    agent's provider process stops and its in-memory timeline is dropped, but only when it is idle
    with no run, has no pending background wait or permission, is not the target of an active
    schedule or heartbeat nor the child of a running orchestrator, has no child processes under its
    runtime (closing tree-kills them, which would stop a dev server it started), is not internal,
    and has a stored session to resume. The agent stays stored and shown as idle: no closed state
    is broadcast, because "Archive finished" and other client logic treat only `idle` as done. The
    next prompt or send resumes it through `ensureAgentLoaded`, the path every agent takes after a
    daemon restart, with the same timeline epoch and rows (about 1 s for Pi); opening it answers from
    storage first (delta 58). (e) pi-local's
    browser credential broker loads its MCP client on first use (about 34 MB less per Pi). Key
    files: `packages/desktop/src/features/browser-webviews/{lifecycle,index}.ts`,
    `packages/desktop/src/features/browser-automation/{ipc,service}.ts`,
    `packages/app/src/desktop/browser/{resident-webviews,automation/handler}.ts`,
    `packages/server/src/utils/directory-suggestions.ts`,
    `packages/server/src/server/session/files/directory-suggestions-scheduler.ts`,
    `packages/app/src/assistant-file-links/use-file-link.ts`, and
    `packages/server/src/server/agent/{idle-agent-unloader,agent-manager}.ts`.

34. **Read, find, richer waits, and HTTP status in browser tools** — from the 2026-10-05
    Lightpanda comparison and 30 days of browser calls (388 sessions, 5,823 calls through
    `browser_evaluate`): agents scraped page text 664 times, collected links 703 times, read
    `innerText`/`textContent` 2,750 times, searched elements by text 934 times, and wrote 203
    `setTimeout`/promise polling loops beside 1,116 `browser_wait` calls; and `browser_navigate`
    reported success on a 404 page. All four are additions to the `paseo` MCP browser tools
    (reached through the gateway, so their schemas cost no prompt tokens); existing calls
    behave as before. The engine stays Chromium.
    - `browser_read` returns the tab as Markdown. One page-injected script (Readability +
      Turndown with GFM tables, evaluated against a local `module` so nothing lands on
      `window`) works on a copy of the rendered tree: hidden (`display:none`,
      `visibility:hidden`, `hidden`, `aria-hidden`), script, and media elements are left out,
      open shadow roots and same-origin frames are inlined through `contentDocument`
      (delta 27), cross-origin frames read `[iframe: <src>]`, links are absolute, images keep
      only `![alt]`. `scope: "main"` (default) runs Readability and falls back to the whole
      page below 500 characters, saying so. Since 0.5.46 a page that declares itself a product
      (`og:type` product, or a JSON-LD Product/ProductGroup/IndividualProduct/ProductModel)
      skips Readability and reads whole (`whole page (product page)`), and any other page keeps
      Readability's pick only when it holds the text of the first visible h1 (the h1 passes
      through as a marked paragraph, because Readability deletes the heading that repeats the
      title), because on the HDEX product page Readability chose the 1,423-character "최근 본
      상품" sidebar over the heading, price table, and option lists. `page` drops page-level landmarks by the HTML-AAM
      rule (`nav`, `header`/`footer`/`aside` outside sectioning content, explicit
      banner/contentinfo/navigation/complementary roles); `ref` reads one snapshot element.
      A JSON-LD (Product, ProductGroup with variants, Offer, Article, Organization) and
      `og:`/`product:` meta summary, capped at 2,000 characters, comes before the body,
      because Readability picked an exchange-policy block as the HDEX product page's article
      and missed the price, sold-out state, and options that only JSON-LD and meta carry.
      `maxChars` defaults to 40,000 (max 120,000) and never splits a surrogate pair;
      `stats.chars` is the full length. Layout tables (nested or `role=presentation`) become
      blocks and data tables get a header row. The text block carries the page and
      `structuredContent` only the metadata. Slow reads follow evaluate's 14-second and
      navigation rules; a stuck load says the tab is still loading.
    - `browser_find` matches by ARIA role and accessible name (case-insensitive substring,
      `exact`, or `/regex/flags`) with the snapshot's own role, name, visibility, and state
      code (`ARIA_SHARED_SOURCE`). Actionable matches return the element's document-lifetime
      ref (0.5.35) and are added to the latest snapshot's refs instead of replacing them, so
      both keep resolving. Each match names its nearest landmark or dialog
      (`in navigation "상단 메뉴"`); `total` counts matches past `limit` (10, max 50).
    - `browser_wait` takes exactly one of `text`, `url`, `selector` (attached, through
      same-origin frames and open shadow roots), `script` (Playwright `waitForFunction`:
      expression or function, awaited, a throw or syntax error fails at once, inlined so an
      eval-blocking CSP does not matter), or `load` (`load`, or `networkidle`: not loading and
      no request in flight for 500 ms, counted through the tab's CDP Network domain, which
      `browser_network` capture now shares by reference so either can run without the other).
      One poll never outlives the wait's deadline. A lone `timeoutMs` still pauses. A
      networkidle match reports `matched: "networkidle"` (0.5.46; 0.5.45 said `load`).
    - `browser_navigate` reports the committed URL and the main-frame HTTP status from
      `did-navigate`: `Navigated to … (HTTP 200)`, and for 400 and above
      `…, but the server answered HTTP 404 Not Found` plus a note that the content is the
      site's error page. `back`/`forward`/`reload` now wait for the commit (up to 10 s, ending
      early when loading stops without one) and report it too. Same-document moves and old
      hosts report as before.

    The protocol changes are additive and ledgered; new wait conditions reach only the desktop
    host that ships with the daemon. Key files: the
    `packages/desktop/src/features/browser-automation/` modules `read-script`, `read`,
    `aria-snapshot-script`, `snapshot-engine`, `network-capture`, `ipc`, and `service`;
    `packages/server/src/server/browser-tools/tools.ts`;
    `packages/protocol/src/browser-automation/rpc-schemas.ts` and `paseo-tool-call-detail.ts`.

35. **Browser tools tuned for debugging** — from the 2026-10-06 comparison with Chrome DevTools
    MCP, Playwright MCP, and agent-browser against 30 days of browser calls (104 sessions):
    - `browser_evaluate` inlines the function into the injected script instead of passing it to
      `eval`, the way `browser_wait` script already did; Node checks the syntax first, since an
      inlined syntax error only comes back as a generic injection failure. Pages whose CSP lacks
      `unsafe-eval` or that require Trusted Types (Meta Business, Slack API, Stripe docs) had
      failed 64 times in 40 days. The 14-second timeout message now points at `browser_wait`
      `selector`/`script` (49 of 75 evaluates after 0.5.45 still polled in the page).
    - Every browser tool rejects parameters it does not take, naming the right one
      (`path → savePath`, `timeout → timeoutMs`) and listing its parameters. The SDK used to
      strip them: about 250 calls in 30 days, including 23 screenshots that reported success
      with no file written and 35 waits that ran the default 5 s.
    - `browser_logs` marks console messages logged before the tab's latest main-frame
      navigation `previousPage` (a reload repeats the same errors) and takes `level`
      (`debug|info|warning|error`, that level and above); its summary counts errors, earlier
      pages, and failed or 4xx/5xx requests.
    - `browser_snapshot` takes `ref` (that element's subtree) and `interactive` (elements with
      refs and the named containers around them); the whole page is still walked, so every ref
      stays live. Agents had passed `filter`/`selector`/`query`/`interactiveOnly` 55 times.
    - `browser_screenshot` takes `ref`: the element scrolled into view, its box (plus
      same-origin frame offsets) clipped to the viewport and passed to `capturePage`.
    - `browser_resize` takes `mobile`, `userAgent`, and `deviceScaleFactor`. The app sizes the
      webview and then sends the same resize to the desktop host, which applies DevTools'
      device mode over CDP: `Emulation.setDeviceMetricsOverride` (width/height 0, DPR, mobile),
      touch emulation with 5 points, and a user agent with matching client hints (Android
      Chrome by default with the browser's Chrome major; none for an iOS user agent). A resize
      without the fields clears it; the app only contacts the host for a tab it emulated. A
      HYM session had faked 18 in-app user agents in jsdom because the tab could not.
    - New `browser_styles`: `CSS.getMatchedStylesForNode` and `CSS.getComputedStyleForNode`
      inside one CDP queue slot, with `CSS.enable` reporting stylesheet URLs through
      `styleSheetAdded`, then CSS and DOM disabled again. Rules come highest precedence first
      with selector, sheet URL and 1-based line, and `@layer/@supports/@media/@container/@scope`
      conditions; declarations that lose are `overridden`, unparsable ones `invalid`;
      ancestors contribute inherited properties only; browser-default rules are counted.
      `properties` narrows by name (a shorthand matches its longhands). Agents had scanned
      `document.styleSheets` by hand 45 times, which cannot read cross-origin sheets.

    Verified in real Electron by the capture harness `debugging` group
    (`docs/browser-capture-harness.md`). Protocol additions are optional fields and a `styles`
    command gated through `browserHost.supportedCommands`, ledgered. Rejected with reasons in
    the 2026-10-06 research: console object previews (need `Runtime.enable`, a bot-detection
    signal), performance traces, Lighthouse and heap tools (83 performance evaluates in 30
    days), React source mapping (2), and an always-on request log (`browser_logs` already
    shows the page's requests with status). Key files: the browser-automation modules
    `css-styles`, `device-emulation`, `snapshot-engine`, `ipc`, and `service`;
    `packages/app/src/desktop/browser/automation/handler.ts`;
    `packages/server/src/server/browser-tools/tools.ts`;
    `packages/protocol/src/browser-automation/rpc-schemas.ts`.

36. **New tabs open Google; the address bar searches** — upstream opens `https://example.com`.
    `DEFAULT_BROWSER_URL` is `https://www.google.com` for user and agent tabs, and address-bar
    input that is not URL-shaped (no scheme, local host, or `host.tld`; any whitespace) goes to
    Google search, as Chrome's omnibox does. `host:port` is no longer mistaken for a scheme.
    Agent navigation is unchanged. Key file: `packages/app/src/desktop/browser/store/state.ts`.

37. **Workspaces name themselves from what the session is doing** — upstream names a workspace
    only when it is created together with its first agent, and only with Haiku, GPT-5.4 mini,
    MiniMax, or Nemotron. Daseo's empty-workspace launch (`7fe3cbba4`, 2026-08-16) creates the
    workspace first, so from then on almost every sidebar row showed the folder or branch name,
    and Pi exposes none of those models, so scheduled runs failed with zero candidates.
    The newest Luna in the roster (matched by family name, highest version wins, so
    `gpt-6.1-luna` or `gpt-7-luna` is picked up without a code change) at `low` now leads the
    metadata model list. A user prompt to a top-level agent
    (its create prompt or a later message) names an untitled workspace, and re-evaluates an
    auto title: prompts under 12 characters and prompts within 3 minutes of the last check are
    skipped, the model is told to keep the title unless the task clearly changed, and it sees
    the last 4 prompts. The persisted `titleSource` marks `auto` and `manual` titles; a rename
    sets `manual` and locks the title, clearing it unlocks, and legacy or prompt-derived titles
    (null source) are never touched. Metadata agents run in `$TMPDIR/daseo-metadata`, so they
    skip repository instructions and never feed the home-directory personal-memory extension.
    Key files: `packages/server/src/server/workspace-title-generator.ts`,
    `packages/server/src/server/workspace-auto-name.ts`.

38. **A Pi process that dies between turns puts the agent in `error` and relaunches on the next
    prompt** — from the 2026-10-15 Herdr comparison. Upstream drops a Pi `process_exit` when no
    turn is active: the agent stays `idle`, its `wait_for` waits (deltas 29/30) are cleared
    without a word, and the wake that would have continued its work never arrives. Pi now emits a
    turn failure with no turn id, as the Claude provider already does, worded "Pi stopped
    unexpectedly (exit code N). K background wait(s) it was holding were lost (labels); Daseo is
    prompting the agent to re-check and continue." (delta 44 sends that prompt) with the exit code and Pi's stderr tail as
    `code`/`diagnostic`. An exit that follows `close()` (archive, reload, idle unload from delta
    33, daemon shutdown) reports nothing. Upstream also never replaced a dead Pi process, idle or
    mid-turn, so every later prompt failed with "Pi RPC process is closed" until a reload; the
    session now starts a new Pi process on the same session file before the next turn, with the
    current model, thinking level, and feature values. Internal `--no-session` agents have nothing
    to resume and keep the old behavior. Key file:
    `packages/server/src/server/agent/providers/pi/agent.ts`. Takes effect with the next release
    and daemon restart.

39. **An unreadable store file is copied aside before it can be overwritten** — upstream logs a
    corrupt store, starts empty, and the next write replaces the only copy. The workspace and
    project registries, device pairings, command receipts, push tokens, and push events now copy
    the original bytes to `<file>.corrupt-<YYYYMMDDTHHmmss-mmmZ>` (same mode, newest 3 kept,
    pruned only after the new copy exists) and log `backupPath`. The daemon still starts with
    empty state; nothing restores automatically. Device pairings and receipts back up only on a
    schema failure, because a JSON syntax error there already stops the daemon. Key files:
    `packages/server/src/server/atomic-file.ts`, `workspace-registry.ts`,
    `device-pairing-store.ts`, `agent/agent-command-receipt-store.ts`,
    `push/{token-store,event-store}.ts`. Takes effect with the next release and daemon restart.

40. **Android "needs you" notification channel** — upstream sends every push on
    `agent-updates`. Permission requests and errors sent through direct FCM (the personal
    variant) now go to `agent-needs-you` (importance MAX, bundled two-tone
    `agent_needs_you.wav`, longer vibration); "finished" stays on `agent-updates`, whose settings
    are untouched because Android freezes a channel's sound and importance once it exists. One
    mapping in the protocol package drives the FCM `channel_id` and the app's channel creation.
    An app that has not created the channel yet gets FCM's manifest default, so the push still
    shows. The Expo path intentionally stays channel-less: Expo drops a push whose channel the
    app has not created, so an older production or development build would silently lose
    permission and error alerts. The daemon side takes effect with the next release and daemon
    restart; the channel and sound arrive with the next Android build. Key files:
    `packages/protocol/src/agent-attention-notification.ts`,
    `packages/server/src/server/push/{fcm-service,push-service}.ts`,
    `packages/app/src/push-notifications/internal/subscriptions.ts`, `packages/app/app.config.js`.

41. **The phone stays awake while a remote browser stream is on screen** — the native viewer
    (delta 1) holds an `expo-keep-awake` lock tagged `browser-remote-stream` only while it is
    receiving: pane visible, app foregrounded, host connected and streaming-capable, stream not
    stopped. Hiding, backgrounding, disconnecting, a stopped stream, or unmount releases it.
    Electron and web viewers are unchanged. Key files:
    `packages/app/src/hooks/use-keep-awake-while.ts`,
    `packages/app/src/desktop/browser/pane/index.tsx`. Takes effect with the next Android build.

42. **A project whose workspaces are all pinned keeps its sidebar header** — upstream's pin
    split (#1981) dropped a project once every workspace of it sat in the Pinned section, to
    avoid a duplicate header. Archiving the last unpinned workspace then made the project vanish
    from the sidebar along with its "new workspace" row, while a project with no workspaces at
    all stayed. The project now stays as an empty header with the "new workspace" row, the same
    as an empty project. Key file: `packages/app/src/hooks/use-sidebar-pins.ts`. Takes effect
    with the next Mac release and Android build.

43. **Frozen tabs give their memory back under macOS memory pressure** — delta 33 freezes a
    parked tab but keeps its memory, and a Cafe24 workspace opens dozens of tabs at once; on
    2026-10-18 the Mac ran out of memory. Measured on Electron 41.10.6: a frozen 1.1 GB page stayed
    1.1 GB, and navigating it to `about:blank` in place kept the same renderer and grew it on
    return, while `webContents.forcefullyCrashRenderer()` released all 2.2 GB, kept the URL,
    title, back/forward history, and the attached debugger, and `reload()` restored the page in a
    new renderer in about 3 s without touching other tabs. So, Chrome-style, only while
    `sysctl kern.memorystatus_vm_pressure_level` reports 2 (warning: at most 2 tabs per 30 s
    check, unused 60 minutes) or 4 (critical: every eligible tab unused 30 minutes), a frozen,
    unheld plain tab (webview guest; never a popup, whose reload can break an OAuth or payment
    opener) has its renderer ended and becomes `discarded`; the next wake (pane presentation,
    automation command, capture, phone stream) reloads it before answering. Never discarded, like
    Chrome's "user entered text in a form" rule: a tab typed into by the user (any editing
    `before-input-event` key, IME composition included) or an agent (`fill`, `type`, `keypress`,
    `select`, `upload`, `evaluate`, `drag`, `stream_input`) since its last cross-document
    navigation; a tab edited without a key (the context menu's Cut/Paste in an editable field, or
    any `input`/`change` event: a ticked box, a picked option, a dropped file, autofill), read
    from an isolated world (1043) just before the tab freezes, with a page that cannot answer in
    1 s or that loaded before the watcher counted as edited; a tab downloading or exempt from
    freezing; a tab sharing its renderer process with any other page. A restore whose renderer
    is still crashed after the 30 s wait reloads once more and otherwise leaves the tab discarded
    so the next wake retries; a page still loading has a live renderer and counts as restored.
    Real Electron check (0.5.53): a mouse-only checkbox tab, a right-clicked text field, and a
    tab loaded before the watcher were all kept; an untouched tab was discarded and restored in
    0.05 s with its title and watcher back. Delta 97 adds a discard without memory pressure after
    a long idle time. Off together with `browser.suspendIdleTabs`. Key files:
    `packages/desktop/src/features/browser-webviews/{discard,lifecycle,index}.ts`,
    `packages/desktop/src/features/browser-automation/ipc.ts`, `packages/desktop/src/main.ts`.

44. **Nothing an agent waits on is lost silently** — from the 2026-10-18 audit of 1,661
    `wait_for` waits: every recorded wake was answered (p50 7 s), but 14 waits died on Daseo
    activations, 2 inside new-agent schedule runs, and 2 child finish notifications with them, and
    each agent sat idle "waiting" until a human prompted it. Upstream has the same gaps (its
    finish observer is in memory too and its schedule runs archive at the first idle). Now:
    (1) `restart-recovery.ts` journals to `$PASEO_HOME/restart-recovery.json`, debounced on every
    state change and synchronously at shutdown before agents close, which agents hold background
    waits or are mid-turn and which notify-on-finish watchers exist; the next start (5 s after
    listen, journal at most 12 h old) re-arms the watchers, delivers a finish notification the
    shutdown cut off, and prompts each affected agent with a recovery notice that tells it to
    check what took effect before re-running anything (a wait's command dies mid-run) and to
    answer `[wait noted]` when nothing is left. The same notice goes out after a session reload
    and after a Pi death between turns (delta 38, via `turn_failed.lostBackgroundWaits`). One
    automatic notice per agent per 10 minutes, so a crash loop cannot become a prompt loop.
    (2) A finish watcher reports `errored` once per run and keeps watching, so a child that
    recovers later still reports its finish. (3) A new-agent or agent-target schedule run follows
    the agent's wake turns until no wait is pending (at most `BACKGROUND_WAIT_HOLD_MAX_MS`) before
    it records the result and archives. (4) Activation scripts gate on
    `packages/desktop/scripts/daseo-activation-gate.mjs`: one snapshot with no running agent and no
    pending wait, clean again after a 20 s settle window, and a second call with no settle window
    right before the app quits; waits are honored for 90 minutes, then the restart recovery covers
    them. Key files: `packages/server/src/server/agent/{restart-recovery,restart-recovery-runner,agent-prompt,agent-manager}.ts`,
    `packages/server/src/server/bootstrap.ts`, `packages/server/src/server/schedule/service.ts`,
    `packages/desktop/scripts/daseo-activation-gate.mjs`.

45. **"Add image" keeps working after Android recreates the Activity** — reproduced on the
    Galaxy Z Fold 7 on 2026-10-18: once MainActivity was destroyed and recreated in a live process
    (folding or unfolding, font scale, locale, display size), every "Add image" showed "Failed to
    select image" until the process restarted. The native cause was `IllegalStateException:
Attempting to launch an unregistered ActivityResultLauncher`, which is expo/expo#50386. "Upload
    file" kept working because expo-document-picker uses plain `startActivityForResult`. Fixes:
    (1) `patches/expo-modules-core+3.0.29.patch` backports expo/expo#49634 (shipped only in
    expo-modules-core 58). `launch()` registers a dropped launcher again against the live
    Activity. (2) `patches/expo-image-picker+17.0.10.patch` releases the native open-picker guard
    when the Activity dies mid-pick. Otherwise every later launch silently returns canceled.
    (3) `plugins/with-android-fold-config-changes.js` adds `smallestScreenSize` to MainActivity
    `configChanges` (React Native's own template has it; Expo's omits it). Folding no longer
    recreates the Activity. Both screens use density 420/360, so `density` is not needed.
    (4) The picker hook releases a guard whose launch never settled once the app has been active
    for 1.5 s. Its alert now carries the error reason, and the composer catches persist failures
    with a toast. (5) Photos over the image budget (raised to 52M pixels so 50MP shots are
    images) upload as files instead of failing the pick; 200MP shots fall in this group.
    (6) `DaemonClient.uploadFile` waits for the connection (`waitForConnection`, which starts a
    reconnect) before sending frames. Samsung's Freecess froze Daseo about 13 s into a picker,
    and the upload failed with "Transport not connected" on return. Upstream #5585 covers only
    the `connecting` case. Key files: `packages/app/src/hooks/use-image-attachment-picker.ts`,
    `packages/app/src/attachments/image-budget.ts`, `packages/client/src/daemon-client.ts`,
    `scripts/postinstall-patches.mjs`. Takes effect with the next Android build (5 also on
    desktop).

46. **Images travel through the chunked upload, not inline in the message** — upstream
    getpaseo/paseo#2668 (open). An image sent inline as base64 in the message JSON is encrypted
    and base64'd again for the relay (about 1.78x on the wire), so a few photos overflow the
    32 MiB relay frame and the relay drops the connection. When `server_info.features.imageUploads`
    is true, the app sends each encoded image through `file.upload.request` (1 MiB binary frames)
    and puts `imageUploads: [{ uploadId, mimeType }]` on `send_agent_message_request` /
    `create_agent_request` with `images: []`. The daemon reads
    `$PASEO_HOME/uploads/<uploadId>/` (id pattern-checked, image MIME only) and merges the bytes
    into `images` before the command-receipt hash, so a retried command with fresh uploads of the
    same bytes hashes the same. Providers see the same inline images as before. An older daemon
    strips the field, and the app then sends inline as before. Key files:
    `packages/server/src/server/file-upload/image-uploads.ts`,
    `packages/server/src/server/session.ts`, `packages/app/src/composer/actions.ts`,
    `packages/app/src/utils/encode-images.ts`, `packages/protocol/src/messages.ts`. Takes effect
    with the next release, daemon restart, and app build.

47. **A chat left open across a connection switch keeps receiving live updates** — from the
    2026-10-21 phone incident (agent `ceef0f04`): a sent message stayed on "Sending..." while the
    daemon persisted it and the reply. The host runtime's `switchToConnection` (probe found the
    active connection unavailable, or three faster probes in a row) replaces `snapshot.client`
    while `connectionStatus` stays `"online"`. `session-context.tsx` recreates the viewed-timeline
    sync for the new client, and a new sync started disconnected; the only thing that connected it
    was the `[isConnected]` effect, which does not run on `true → true`. The new sync never sent
    `agent.timeline.set_subscription.request` or the catch-up fetch for the open chats, so the
    daemon's selective delivery dropped every `agent_stream` for them on the new socket. RPCs
    still worked, which is why the send succeeded. Now `createViewedTimelineSync` takes
    `initialConnected` beside `initialDeliveryMode`, and the context seeds it from the host
    runtime snapshot when it creates the sync. The `[isConnected]` effect still handles later
    transitions. Upstream has the same wiring (`origin/main` session-context.tsx) and is a
    candidate for an upstream PR. Key files: `packages/app/src/contexts/session-context.tsx`,
    `packages/app/src/timeline/viewed-timeline-sync.ts`. Takes effect with the next app build.
48. **Browser logs reach the model in the text, so the structured copy can stay out of context** —
    from the 2026-10-21 environment audit: pi-mcp-adapter appended every MCP result's
    `structuredContent` after its text, which was 70% of all Paseo tool-result characters in 14
    days (4.19M of 5.97M). Agent tools already print their JSON in the text, and every browser tool
    but one prints what an agent needs; `browser_logs` printed only counts, with the entries in the
    structured copy alone (1.6M characters). Its text now lists each console entry (ISO time, level,
    `previousPage`, message, source:line) and each resource request (status, method, URL, type,
    duration, size, start). With that, pi-local's launcher sets `appendStructuredContent: false` on
    the Paseo server (adapter 5.4.0), so Pi sees the text only; scripts still read
    `structuredContent`. The MCP spec asks servers to serialize structured results into the text,
    and the official Python SDK names the text the model's copy. Key file:
    `packages/server/src/server/browser-tools/tools.ts` (`summarizeBrowserDiagnosticsSuccess`).
49. **Interface details from Ovis (herdr web UI)** — from the 2026-10-22 read of devswha/herdr-web-ui
    (`ee2daec`, its DESIGN.md and client). Most of its chat surface already matches Daseo; these are
    the parts Daseo lacked. (a) While the phone app is on screen it suppresses OS banners, so an
    agent elsewhere that finished or asked for permission changed only a dot in the closed
    sidebar. It now drops an in-app alert: a black drop falls under the header, spreads into a
    card (one 44pt line as wide as its text on compact screens, a two-line card with the answer's
    first words on wider ones), a tap opens the agent, a drag or flick up puts it away, and it
    leaves 3.6 s after its text shows, waiting while touched; a newer alert folds the current one
    away first, and reduce motion fades it in place. Native only: desktop keeps its OS
    notification. (b) The folded "Worked for …" row says what the work was: `Worked for 7s · 2
edits · 1 command · 2 file reads`; the counts end in an ellipsis before the time is cut.
    Failed tools stay visible (delta 5), so there is no failed count. (c) A prompt longer than 12
    lines of the widest bubble (a CJK character counts two columns) folds behind "Show full
    message"; a shorter one never shows the toggle. (d) A code block longer than 30 lines opens
    at its first 20 behind "Show all N lines"; copy still takes the whole block. (e) Reduce motion
    now stills the running tool's shimmer, the sidebar and PR skeleton pulses, and the startup
    logo shimmer, as the synced loader already did. Not taken: hover-only message metadata (delta
    32 keeps it always on), Ovis's amber palette and Pretendard font (a rebrand, not a fix), its
    PWA, SSH bridge, and terminal-scraped dialogs (Daseo talks to Pi over RPC). Key files:
    `packages/app/src/components/attention-droplet.tsx`, `stores/attention-droplet-store.ts`,
    `utils/attention-droplet.ts`, `agent-stream/collapsed-work.ts`, `components/user-message-fold.ts`,
    and `components/highlighted-code-block.tsx`.
50. **The Android release build fits the 24 GB Mac mini** — from the 2026-10-22 memory audit.
    zod-aot's inline mode wrote every discriminated-union branch of the WebSocket envelope into
    one function (9.8 MB of the 10 MB generated validator, 99 functions in all), and hermesc's
    register allocation grows faster than linearly with function size: compiling the release
    bundle peaked at 16.3 GB footprint and pushed the Mac into swap. The protocol generator now
    patches the emitter so each branch body runs in its own closure (872 functions, largest
    270 KB). Measured on the same bundle: hermesc peak 16.3 GB → 2.3 GB, 45 s → 10 s, bytecode
    27.3 MB → 24.2 MB; old and new validators returned identical results (data and issues) on
    10,044 messages (324 captured from the live daemon plus 9,720 mutations); validation on
    Hermes 79 ms → 68 ms for 1,020 messages. `npm run build:daseo:android` also stops the Gradle
    daemon, and with it the Kotlin daemon, when Gradle exits: release builds are hours apart, so
    the warm daemons were never reused but held about 7 GB for up to 3 hours. Key files:
    `packages/protocol/scripts/generate-validation-aot.mjs`, `scripts/build-daseo-android.mjs`.
51. **A terminal tool's look and a steadier stream** — from the 2026-10-22 CLI-look and smoothness
    research. The owner's screen is seen by colleagues, so Daseo should read as a developer tool
    without copying Codex or Claude Code. (a) Fonts ship with the app: Pretendard 1.3.9 for the
    desktop UI, and NAVER D2Coding 1.4.0 (Regular, Bold; OFL, shipped unmodified) as the monospace
    on desktop and Android, so Hangul in code matches the body (since delta 53 the body is D2Coding
    too). (b) Machine facts use the monospace: timestamps, elapsed time, the "Worked for" row,
    diff counts, and keycaps. (c) A one-line status bar
    under the desktop workspace (web and desktop app only; since 0.5.118 the native app never shows
    it, the owner did not want that footer under the composer on the unfolded Fold): host · workspace · branch · active agent's model, and how many
    agents run in the workspace. (d) The Daseo theme's corners drop from 8 to 4 px (radius scale
    0/2/2/3/4/6/8); the selected sidebar row also gets a 2 px rail on its left, reserved on every
    row so text never shifts. (e) Shortcuts are keycaps: mono text in a hairline-bordered key, and
    the composer's focus hint draws its shortcut as one. (f) A streaming reply is revealed at the
    Codex TUI pace (`codex-rs/tui/src/streaming/chunking.rs`, same thresholds): one line per frame,
    the whole backlog when it is 8 lines deep or 120 ms old, back to one line after 250 ms at ≤2
    lines and ≤40 ms, re-entry held 250 ms unless 64 lines or 300 ms behind. A "line" is source
    text up to a newline or 80 characters. Reduce motion and replies mounted mid-stream show text
    whole. (g) On desktop, following output glides to the new bottom (40% of the gap per frame,
    about 130 ms for 200 px) instead of jumping; reading above the bottom still stops following,
    and a jump taller than the viewport snaps. (h) App-authored motion uses one scale: 120 ms for
    tooltips, menus, and rails, 180 ms for switches and row fades, 100 ms exits, one easing
    curve (0.2, 0, 0, 1). Not taken: neon, gradients, scanlines, or tighter spacing (2026-08-17
    rules; the rule against monospace Korean prose was lifted by delta 53). Key files: `packages/app/src/styles/bundled-fonts.web.ts`,
    `styles/motion.ts`, `agent-stream/stream-pacing.ts`, `agent-stream/use-paced-stream-text.ts`,
    `agent-stream/strategy-web.tsx`, and `screens/workspace/workspace-status-line.tsx`.
52. **A navigation that lands is not reported as a failure** — from the 2026-10-22 Ego Lite
    review. When a redirect or a page script takes over after the requested document committed,
    `loadURL` rejects with ERR_ABORTED although the tab holds a loaded page; `browser_navigate`
    returned `browser_unknown_error` and agents spent a turn re-checking (17 tool results in 12
    sessions over 60 days, e.g. Scout adding query parameters, Slack file links). With a
    main-frame commit the result is now ok, at the URL the tab is on, with the commit's HTTP
    status when that URL is the committed one. ERR_ABORTED without a commit (a download, or
    nothing loaded) and every other net error stay failures. Key file:
    `packages/desktop/src/features/browser-automation/service.ts` (`supersededNavigationResult`).
53. **D2Coding everywhere and a one-line prompt** — the owner's call on 2026-10-23, after
    delta 51 left the body text looking unchanged (Pretendard is drawn to match Apple SD Gothic
    Neo, and Android prose kept the system face). The interface font default is NAVER D2Coding on
    web/Electron and Android, Korean prose included; Pretendard stays as the web fallback, iOS
    keeps the system face (no embedded font), and the appearance setting still overrides it.
    React Native has no font cascade, so `patches/react-native+0.81.5.patch` makes a root `Text`
    and every `TextInput` without their own `fontFamily` use the family the app publishes at
    startup (`screens/settings/appearance/native-root-font.ts`, set before the first paint and
    again whenever appearance settings load or change); nested text inherits from its root. The
    composer is a terminal prompt line on desktop and mobile: only the top rule remains, on the
    page background (`composer/input/input.tsx`). Not measured on the Fold before release: Korean
    line heights tuned in delta 8 against the system face.
54. **A subagent that goes silent is reported to its caller** — from the 2026-10-23 wait audit
    (306 waits since 2026-10-18: no lost wake, but a caller waiting on `notifyOnFinish` had no
    deadline at all, and nothing noticed a child that stayed "running" without progress). The
    finish watcher now also checks once a minute: a child whose lifecycle is `running`, with no
    pending permission, and with no event of any kind for 20 minutes is reported to the caller
    once as `Agent <id> (<title>) has shown no progress for 20 minutes.` with a pointer to
    `get_agent_activity` and `cancel_agent`; any later child event re-arms it, and the finish
    notice still follows. An idle child holding wait_for waits is left to their own deadlines and
    check-ins (pi-local `5f3398a`). The status line does not match the app's four agent reasons, so
    the app shows it as a plain system row. Key file: `packages/server/src/server/agent/agent-prompt.ts`
    (`FINISH_WATCH_STALL_MS`, `checkStall`).

55. **A terminal tool on Tokyo Night** — the owner's call on 2026-10-23 ("더 터미널스럽게, cli스럽게",
    selection still obvious). Delta 89 replaced this palette with Ubuntu aubergine; it lives on as
    the Tokyo Night theme option. The Daseo theme was Tokyo Night: chat `#1a1b26`, sidebar and tab bar
    `#16161e`, text `#c0caf5`, and one accent (`#7aa2f7`) for everything active or selected; status
    and diff colors keep their meaning. Every theme radius is 0 (dots and pills included), and on
    web a root rule squares the literal radii too (`styles/terminal-chrome.web.ts`). The one exception is
    the running indicator in the sidebar and tabs, which stays a ring (owner's correction the same day:
    squared, its quarter arc reads as a bar sliding around a box); it uses a literal radius and a
    `data-daseo-round` exemption (`components/status-ring/frame.tsx`). Text fields get a
    block cursor in the accent: CSS `caret-shape: block` on web (Chromium 146 in Electron 41) and an
    app-theme cursor drawable on Android (`plugins/with-android-block-cursor.js`). A selected sidebar
    row is a `>` pointer plus an accent title (`components/sidebar/sidebar-selection-pointer.tsx`, the
    slot always reserved) instead of a fill with a rail; hover keeps its light fill. No rule between
    sidebar and chat, none between tabs or under the tab bar; the active tab is its accent label with
    a 1 px accent underline. A submitted prompt is a left-aligned input line with a `>` marker, not a
    right-aligned box. Every install switches to this theme once (`daseoTerminalTheme: 55` in the
    stored settings blob, `hooks/use-settings/storage.ts`), and a theme picked later sticks. The same
    marker at 56 hides the sidebar's `+N -M` diff count once (owner's call the same day: not needed);
    the row's trailing-slot setting still brings it back, and new installs default to nothing there.

56. **Transcript paths open on the Mac** — the owner's call on 2026-10-23 (opening "saved it here"
    paths by hand was tedious). On the Mac app, with the transcript's daemon on this machine, a path
    link to a folder opens in Finder and one to a page, PDF, image, media file, or office/HWP
    document opens in its macOS app (HTML in the default browser, Chrome here). The desktop main
    process stats the path and decides (`packages/desktop/src/features/opener.ts`,
    `paseo:opener:openLocalPath`); source, text, logs, unknown extensions, and app/installer bundles
    come back "not-handled" and open in the file pane as before, because the macOS defaults for
    those are wrong (`.ts` opens QuickTime) and a click must never run an agent-named script. A link
    with a line number, a remote daemon's path, and the phone kept the file pane (delta 62 then
    sent everything but a remote daemon's path out of the app). URLs already opened in the default
    browser. App side: `assistant-file-links/use-file-link.ts` (`openInMacApp`), `provider.tsx`
    (`isLocalDaemon`).

57. **The task list and subagents track are status lines** — the owner's call on 2026-10-23: once the
    composer became a prompt line (delta 53), the two cards above it still had a surface1 fill, side
    borders, rounded top corners, and a 16 px tuck under the composer, which now showed through the
    transparent prompt. Both are now a header row under one top rule in the border color, with no
    fill, sides, corners, or overlap (`composer/task-list/index.tsx`, `subagents/track.tsx`). The
    task line carries held, waiting, and dropped tasks since delta 95.

58. **Opening an unloaded chat answers from storage, and the agent loads behind it** — the owner's
    call on 2026-10-24 ("어떤 세션이든 누르면 즉시"). Opening an agent that delta 33(d) unloaded, or one
    not opened since the daemon started, waited for its Pi process to start before the app dropped
    its full-screen spinner: 595 slow `fetch_agent_timeline_request`s from 2026-10-02 to 10-23, p50
    2.7 → 5.3 s and p90 5.2 → 14.2 s as more agents unloaded. The model is Codex app-server's split
    of `thread/read` (stored history, nothing loaded) from `thread/resume`. A timeline page, the
    prompt index, and clearing attention for a stored agent that is not loaded now answer from its
    committed timeline and stored record, and only the unarchived chat on screen then resumes its
    agent in the background: a cold open (a `tail` page with no cursor), or the focused agent of a
    visible client's heartbeat, once per focus (a reopened chat whose rows the app still holds
    catches up with an `after` page; the tracker sends a heartbeat as soon as focus changes).
    `after` and `before` pages never load: the app catches up its five most recently viewed chats
    with them on every reconnect, and the phone reconnects through the relay every few minutes, so
    loading on them restarted up to five hidden agents each time and kept them from ever reaching
    the idle unloader. A chat left on screen still unloads after the idle period; moving focus away
    and back loads it again. The committed view is the seed a resume registers (same epoch, rows, and
    `nextSeq`, open compactions closed), so the page's cursors stay valid after the load and the app
    is unchanged. The stored path applies only when the record has a resumable provider session
    (a record without one is recreated with an empty timeline on load) and committed rows (otherwise
    the load hydrates from the provider); anything else takes the old wait. The background resume
    publishes only its final `idle` state, so the open chat's context meter does not flash a loading
    ring, and a prompt sent meanwhile joins it. Clearing attention writes the record inside the
    storage write queue and leaves `updatedAt` alone, as it does for a loaded agent; a resume never
    restores the flag, so the record and the loaded agent agree. Listing, hovering, and tabs still
    never load an agent, the provider-subagent list still waits for the load it shares, and the
    idle unloader is unchanged. pi-local moved two startup costs off Pi's readiness answer in the
    same change (worktree-scope ownership restore and Claude profile checks), so a Pi resume on a
    6 MB session answers in a measured 0.6 s instead of an estimated 1.35 s. Key files:
    `packages/server/src/server/session.ts`
    (`readUnloadedAgentTimeline`, `loadOpenedAgentInBackground`),
    `packages/server/src/server/agent/{agent-manager,agent-loading,agent-storage}.ts`.

59. **The Composer stops below the header while the keyboard is up (phone)** — the owner's
    report on 2026-10-25 ("입력창에 내용 길어지면 … 다른 것보다 위로 올라와버리던데"). The text
    area's cap was half of `useWindowDimensions().height`, and the whole input area is then
    translated up by the keyboard height. With KeyboardProvider's edge-to-edge mode Android does
    not resize the window for the keyboard, so the cap never knew about it: on the Fold 7 inner
    screen (about 712 dp, keyboard about 280 dp) a 356 dp text area plus status lines, attachments
    and padding reached above the header, and the Composer painted over it because it comes later
    in the tree, which reads as a z-index fault. The cap is now 45% of the height left above the
    keyboard (`react-native-keyboard-controller` `useKeyboardState`, 0 on web): 268 dp on the cover
    screen, 194 dp on the inner screen, 412 dp with no keyboard, never below 160 dp. Key files:
    `packages/app/src/composer/input/input-height.ts`, `packages/app/src/hooks/use-keyboard-height.ts`.
60. **Typing into the streamed browser from the phone, and taps that act like taps** — the owner's
    ask on 2026-10-25 ("모바일에서도 daseo browser 켰을 때 조작 터치라던가 입력이라던가"). Before,
    text could only reach a page through the URL bar, and a phone tap was a synthetic DOM click
    (delta 14's focus isolation) whenever the Mac browser pane was not itself focused, so native
    selects, date pickers, file dialogs and any site that checks `isTrusted` ignored it. Now: (a)
    a tap is trusted Chromium input unless the owner is at the Mac (the host window has focus) with
    focus on something other than this browser; only then does the synthetic click still protect
    that focus (`isHostWindowFocused` on the registry). (b) After a tap, text or key, the host reads
    the page's focused element (following same-origin iframes) and answers `focus: { editable,
multiline, inputType }`, an optional field on `stream_input` results and
    `browser.remote.input.response`. (c) The pane keeps an invisible text field focused while in
    keyboard mode (a ⌨ toolbar toggle, and automatic after a tap that focused an editable field;
    off after a tap that did not), mirrors it into the page by diff — Backspace keys for what the
    page still shows past the common prefix, then one `text` insert — so a Hangul syllable being
    rewritten by the IME (ㅎ → 하 → 한) is one Backspace plus one insert per step; Enter and an
    empty-field Backspace go as keys; a key row above the keyboard offers Esc, Tab, arrows, Del
    and Done. All inputs from one pane travel one promise chain so keystrokes stay in order over
    the relay. The viewport and scroll buttons move up by the keyboard. Not done: pinch zoom, long
    press, double tap. Key files: `packages/app/src/desktop/browser/pane/{remote-typing.tsx,
remote-keyboard.ts,index.tsx}`, `packages/desktop/src/features/browser-automation/{service,ipc}.ts`
    (`readStreamFocus`, `shouldIsolateRemoteTap`), `packages/protocol/src/browser-automation/rpc-schemas.ts`
    (`BrowserAutomationStreamFocusSchema`), `packages/server/src/server/websocket-server.ts`.
61. **The app's errors land in daemon.log** — the owner's report on 2026-10-25 ("요즘 오류가 많이
    나는 것 같아 켤 때마다") could not be traced: the phone keeps no log the Mac can read, wireless
    debugging was off, and past sessions held no error text for it. The app now records every error
    toast, `console.error`, "Possible Unhandled Promise Rejection" warning, fatal/uncaught JS error
    (`ErrorUtils`) and root error-boundary catch (with component stack), folds repeats within a
    minute into a count, keeps at most 200 and records at most 40 a minute, and reports them in
    batches of 50 to the first connected daemon whose `server_info.features.clientDiagnostics` is
    true (`client.diagnostics.report.request`, platform and app version attached). The daemon writes
    one row per event under `module: "client-diagnostics"` with the connection's transport, so
    `grep client-diagnostics ~/.paseo/daemon.log` is the phone's error log. A report that fails is
    retried after 30 s with the batch kept. Key files: `packages/app/src/diagnostics/client-diagnostics.ts`,
    `packages/app/src/components/{toast-host,root-error-boundary}.tsx`, `packages/app/src/app/_layout.tsx`,
    `packages/protocol/src/messages.ts` (`ClientDiagnosticsReportRequestSchema`),
    `packages/server/src/server/session.ts` (`handleClientDiagnosticsReport`),
    `packages/client/src/daemon-client.ts` (`reportClientDiagnostics`).
62. **Paths and links always leave Daseo** — the owner's call on 2026-10-25 ("외부로 열리게 해줘,
    daseo의 새 탭이 아니라; 호환이 잘 안되고 안 열리는 경우가 많아서"), widening delta 56. Mac: a
    folder opens in Finder and an allowlisted document in its app as before; every other existing
    path — source, text, logs, bundles, scripts, and a path with a line number — is now selected in
    Finder (`shell.showItemInFolder`, result `revealed`) instead of opening a file pane; scripts and
    bundles are still never launched. A document whose app refuses it is revealed too. Only a path
    from a remote daemon keeps the file pane; since delta 90 a path that does not exist gives a
    toast instead. Phone: a file path is
    downloaded from the daemon (download token scoped to the file's own directory, so paths outside
    the workspace work) and opened with an Android "view" intent on a content URI (the chooser when
    several apps qualify; `expo-intent-launcher`, new dependency), falling back to the share sheet
    when nothing handles the type and on iOS; the file-explorer download uses the same opener. A
    folder on the phone expands Files down to it, and a missing path gives a toast (delta 90).
    Delta 75 (owner's call
    2026-11-01) narrows the phone half: text, source, data, markdown, HTML, and the images the
    app decodes open in the file pane again, because One UI has no stock viewer for md, csv,
    json, or code and those taps ended in an empty chooser; everything else still leaves the app
    as described here. URLs already opened in the default browser (Mac) and the system browser
    (phone). Key files:
    `packages/desktop/src/features/opener.ts`, `packages/app/src/assistant-file-links/{use-file-link,
use-open-file-externally}.ts`, `packages/app/src/utils/open-downloaded-file.ts`,
    `packages/app/src/stores/download-store.ts`.

63. **The phone survives long streams: a native-heap watchdog and previous-exit reporting** —
    from the Fold 7's logcat on 2026-10-25 (wireless debugging on): the 0.5.67 process died at
    01:53:26 with `OutOfMemoryError: std::bad_alloc` inside Reanimated's UI-update flush
    (`NativeProxy.performOperations` ← `AnimationFrameQueue`) while the owner was opening and
    resuming chats from the phone. Upstream getpaseo/paseo#4408 (open, p1) carries the same
    stack: stale Fabric shadow-node revisions stay alive until Hermes collects the JS wrappers
    that reference them, Hermes does not count their native size, so a long streamed answer or
    many open chats grow native memory while no JS collection happens; React Native collects on
    TRIM_MEMORY_RUNNING_CRITICAL, which Android 14+ never sends to a foreground app (ThePharmer
    measured native heap 601 → 345 MB within 3 s of sending it by hand). The issue's second cause,
    one `workspace_update` per workspace on a checkout, does not apply here (14 active workspaces,
    at most 4 on one checkout). Daseo now samples the native heap every 10 s and, when it is over
    320 MB and has grown 48 MB since the last collection (at most once per 30 s), raises that
    trim level itself through React Native's own MemoryPressureRouter, logging the heap before
    and 3 s after under tag `DaseoMemoryGuard`. The same guard writes the previous process's exit
    reasons (`ActivityManager.getHistoricalProcessExitReasons`, API 30+) to
    `files/daseo-exit-reasons.json`; the app reports each non-routine one (crash, native crash,
    low-memory kill, ANR, signal) into daemon.log through delta 61 on its next start, so a death
    JavaScript never saw still leaves a `client-diagnostics` row with scope `process-exit`. Key
    files: `packages/app/plugins/with-android-memory-guard.js` (prebuild writes
    `DaseoMemoryGuard.kt` from `plugins/android-memory-guard/` and patches `MainApplication.kt`;
    `android/` itself is generated and ignored), `packages/app/src/diagnostics/process-exit-report.ts`.

64. **Holding the side button asks Daseo (the phone as a digital assistant)** — the owner's ask on
    2026-10-25 (Gemini's gesture, for Daseo): hold the Galaxy side button, get a new workspace in
    the home-folder project with a new agent in it, the keyboard up and the microphone listening. (a) Android lists an
    app as a digital assistant when it has an ASSIST activity or a `VoiceInteractionService` with
    `supportsAssist`; Samsung's picker rule is reported both ways, so Daseo ships both: an
    `activity-alias` `.DaseoAssistActivity` on MainActivity, and `DaseoVoiceInteractionService` +
    `DaseoVoiceInteractionSessionService` + a refusing `DaseoRecognitionService` (the metadata
    must name one or the app drops out of the picker; `selectableAsDefault="false"` keeps it from
    becoming the system recognizer; AOSP has no bind permission for recognizers). The three
    services run in an `:assistant` process that returns from `MainApplication.onCreate` before
    React Native loads, because Android keeps the selected assistant service bound for good; the
    delta 63 exit report ignores that process. The session opens `paseo://quick-ask` and hides; it
    disables assist data and screenshots, so the screen the owner was on is never read. (b) Every
    entry ends as that one URL: MainActivity rewrites ASSIST to it before React Native reads the
    intent (expo-linking only delivers VIEW data), a quick-ask intent Android replays from Recents
    after a process death becomes a plain launch (no surprise agent), and a launch while the device
    is locked asks for the unlock (`requestDismissKeyguard`; no `showWhenLocked`, Daseo shows
    private content; the Fold's side button is the fingerprint sensor). A static "빠른 질문"
    shortcut points at the same URL (launcher long-press, Samsung's double-press "app feature").
    (c) The root `quick-ask` route waits for the host, creates a new untitled workspace (the
    daemon names it from the first prompt) and opens a new draft tab in it, every time, exactly
    what the sidebar's "new workspace" row does. The workspace goes into the host's "빠른 질문
    프로젝트" (Settings → host → Workspaces, Android only, stored as `quickAskProjects`), else the
    project rooted at the home folder (`shortenPath`'s `~` rule), else `~` itself. The owner
    corrected 0.5.72-0.5.73 on 2026-10-25: those reused the latest home-folder workspace; its
    `quickAskWorkspaces` key is no longer read. Holding the button while Daseo already shows a session dictates into
    that session instead (the owner's ask, 2026-10-26): MainActivity counts visible activities and
    marks the launch `paseo://quick-ask?from=foreground` when Daseo was on screen for at least
    1 s (Android orders onStart and onNewIntent either way, so a launch from the background never
    counts); the route then reuses the focused agent or draft tab of the last workspace, unless the
    compact layout shows the agent list, where a new session still opens. Either way the compact
    layout switches to the agent panel, so a press with the agent list open no longer leaves the
    new session behind it. The quick-ask marker is keyed by draft id or agent id, and a finished
    quick ask resets on the composer so the same session can take the next one. (d) The draft raises the keyboard
    (focus is retried until the IME is up: an early `showSoftInput` is ignored), starts the
    composer's own dictation, confirms it after 1.5 s below the speech level (0.25 on the
    dictation meter, about −40 dBFS) once speech began, shows "1.5초 후 보냄 · 눌러서 고치기",
    and sends through the composer's normal send action; a tap, a keystroke or focusing the field
    cancels the countdown; no speech in 8 s, an empty transcript or dictation that is not ready in
    4 s leaves the text and keyboard for typing. Thresholds are constants in
    `composer/quick-ask/state.ts`.
    **Speech-to-text: Azure Speech MAI-Transcribe-2** (the owner's call, 2026-10-25). Dictation
    and quick ask share the daemon pipeline with a new provider `features.dictation.stt.provider:
    "azure"` (`providers.azureSpeech { apiKey, region }`, model `MAI-Transcribe-2`, language `ko`):
    each committed segment is one synchronous `transcriptions:transcribe` call. Why: Anthropic has
    no audio input; MAI-Transcribe-2 is $0.10 per audio hour (Microsoft's limited price to
    2026-12-31), #2 on Artificial Analysis's non-streaming STT board (WER 2.0%), Korean, and HYM
    Office measured it best for Korean on 2026-10-07. Voice mode stays `openai | local`. To switch
    back, set `features.dictation.stt.provider` to `local` or `openai` (or turn dictation off) and
    restart the daemon: the speech runtime is built at start, `paseo reload` does not rebuild it.
    Rolling the daemon back below 0.5.72 needs `providers.azureSpeech` and the `azure` value
    removed first; older daemons reject them at config load. The key never sits in git: the 0.5.72
    activation merges `~/.paseo/daseo-azure-speech.pending.json` (written by `npm run
    speech:smoke:azure -- --stage <path>` after a real round trip) into config.json while the
    daemon is stopped. Verify: `apkanalyzer manifest print` shows the alias, the three services and
    the shortcut metadata; `adb shell am start -a android.intent.action.VIEW -d paseo://quick-ask
    sh.paseo.dgk` opens the flow; `npm run speech:smoke:azure` prints a Korean transcript. Key
    files: `packages/app/plugins/with-android-assistant-entry.js` (+ `android-assistant-entry/`
    Kotlin templates), `packages/app/src/{app/quick-ask.tsx,screens/quick-ask-screen.tsx,
navigation/quick-ask.ts,composer/quick-ask/,screens/settings/quick-ask-workspace-card.tsx}`,
    `packages/server/src/server/speech/providers/azure/`.

65. **Sites see the browser profile's Chromium as it is** — from the 2026-10-25 Turnstile
    research (the owner approved its recommendation the same day). Daseo itself added four things a
    page or a server can read that Chromium 146 does not have; measured on 0.5.73 and fixed:
    (a) electron-log's `initialize` registers its preload on every session as it is created and
    listens to every WebContents' console, so every site page and cross-origin frame got
    `window.__electronLog` and site console lines landed in `~/Library/Logs/Paseo/main.log`. The
    preload now goes to the default session only (`getSessions` plus `includeFutureSession:
false`; 5.4.3's typings call it `includeFutureSessions` while its runtime reads the singular,
    so both are set), and Daseo's own console forwarding skips WebContents in the browser profile.
    (b) While a command ran, the prompt recorder kept its state on
    `window.__PASEO_BROWSER_AUTOMATION_DIALOG_STATE__`; the recorder is gone since delta 93, which
    puts Chromium's own `prompt` back instead. The snapshot ref registry moved from
    `window.__PASEO_BROWSER_AUTOMATION__` to `window[Symbol.for('paseo.browser-automation')]`:
    `Object.keys` and `Object.getOwnPropertyNames` no longer list it,
    `Object.getOwnPropertySymbols` still does. Hiding it fully needs an isolated world for every
    ref script and every CDP evaluate that resolves a ref.
    (c) `navigator.languages` was `en-US,en-KR,ko-KR` and Accept-Language `en-US`: Electron builds
    the renderer list from the app locale plus `app.getPreferredSystemLanguages()`, the network
    stack uses the locale alone. The profile session gets the same list through `setUserAgent(ua,
acceptLanguages)`, so the header is now `en-US,en-KR;q=0.9,ko-KR;q=0.8`. `--lang` was rejected:
    it changes Daseo's own locale.
    (d) Electron has no client-hints delegate, so no `Sec-CH-UA*` header was ever sent. One
    `webRequest.onBeforeSendHeaders` listener on the profile session (Electron allows one per
    session; secure URLs only, as Chrome; a header already on the request is kept) adds the three
    low-entropy hints, built from `process.versions.chrome` with Chromium's GREASE seed:
    `"Not-A.Brand";v="24", "Chromium";v="146"`, `?0`, `"macOS"`. Device emulation uses the same
    brand list (it sent `Not_A Brand` 24 first) and the host's platform version for a desktop user
    agent, and an emulating tab's headers follow it (`?1`, `"Android"`; none for an iOS user agent).
    Unchanged on purpose: the user agent string, `navigator.webdriver`, `window.chrome`, and no
    Google Chrome brand. High-entropy hints a server asks for with `Accept-CH` are still not sent.
    Measured in an isolated dev desktop on 2026-10-25 through its daemon's browser tools:
    `typeof __electronLog` `undefined` in the page and a cross-origin frame, automation-named
    window properties `[]` after snapshot, click and evaluate, every header equal to
    `navigator.languages` and `navigator.userAgentData` with and without mobile emulation, and the
    non-interactive Turnstile test still issued a token in about 1 s. Key files:
    `packages/desktop/src/features/{renderer-console-log,browser-profile}.ts`,
    `packages/desktop/src/features/browser-automation/{ipc,device-emulation,aria-snapshot-script}.ts`.

66. **A project's "new workspace" button survives a reconnect** — the owner's report on
    2026-10-26: on the folded Fold 7 the project rows sometimes had the + button and sometimes
    not. A non-git project (the home folder) gets it only when the host supports
    `workspaceMultiplicity`, and the sidebar read a host whose `server_info` had not arrived yet
    (cold start from the replica cache, reconnect) as "not supported". It now reads availability
    (`useHostFeatureAvailabilityMap`): unknown keeps the button, only a host known to lack the
    feature hides it. Key files: `packages/app/src/utils/sidebar-project-row-model.ts`,
    `packages/app/src/components/sidebar-workspace-list.tsx`.

67. **A dictated transcript shows up in the Android composer at once** — the owner's report on
    2026-10-26, the first time dictation ran on the phone (Azure, delta 64): after the pencil
    (accept) or "tap to edit" the transcript was in the draft but the native field still showed the
    old text until the session was reopened. The native field drops a JS replacement whose event
    count it considers stale, and dictation runs while the field is disabled. The root cause on the
    device is not confirmed (wireless debugging was off), so the fix does not depend on it: on
    native a transcript remounts the field (`key` = input generation), which reads the draft as its
    initial text, puts the cursor at the end and refocuses unless the transcript was auto-sent.
    Key file: `packages/app/src/composer/input/input.tsx`.

68. **Agents on the Mac read the phone's logs over the app's own connection** — the owner asked
    on 2026-10-26 for a debug route that works without wireless debugging or Tailscale ADB. The
    Paseo MCP tool `phone_logs` sends `client.debug.collect.request` to the newest connected
    phone (or `clientId`; `list` shows the candidates) and the app answers with
    `client.debug.collect.response`: the last 2,000 JS console lines of every level (an in-memory
    ring installed at startup), on Android the newest 3,000 lines of its own `logcat` (an app
    without log credentials reads only its own UID, so main and `:assistant` both show and no
    consent prompt appears) and the last 5 `ApplicationExitInfo` records with ANR traces. The
    reply is capped near 600 KB. The daemon saves the full dump to `$PASEO_HOME/phone-logs/` and
    returns errors, warnings, exits and logcat W/E/F lines, or `grep` matches. The daemon asks
    only clients whose hello advertises `debug_collect` (`{ platform }`), so older apps never
    see the request. The app must be open or recently backgrounded with its socket alive; a
    sleeping phone times out after 30 s (an FCM wake-up is not built). Error-level events still
    flow on their own through delta 61. Key files:
    `packages/server/src/server/client-debug/`, `packages/app/src/diagnostics/debug-collect.ts`,
    `packages/app/modules/daseo-debug/`. Takes effect with the next release, daemon restart, and
    app build.

69. **The side button always brings Daseo to the front** — the owner's report on 2026-10-26:
    sometimes the long press gave the green microphone dot and no Daseo. The session called
    `startActivity` in `onShow`, which runs before the session window is visible, so Android
    judged it a background launch. A blocked launch into Daseo's existing task delivers the
    intent without moving the task to front (`MOVE_TO_FRONT_AVOID_LEGACY`, `mDoResume=false`). A
    sleeping-top or paused Daseo then ran the quick ask invisibly: 2026-10-26 06:42:19 an empty
    workspace and, 7 s later, a microphone permission error. Now the session disables its own
    window and calls `startAssistantActivity`, the system launch AOSP starts with BAL allowed
    (`ActivityTaskManagerService.startAssistantActivity`). It opens
    `DaseoQuickAskTrampolineActivity`: translucent, `:assistant` process, `showWhenLocked`,
    excluded from Recents. That activity opens Daseo as a foreground activity. On the lock
    screen it first asks for the unlock and opens nothing if that is cancelled.
    `onLaunchVoiceAssistFromKeyguard` goes through `showSession` for the same path. The quick
    ask also waits for `AppState` "active" before it starts the microphone. Each step logs
    under the `DaseoQuickAsk` tag for `phone_logs`. Key files:
    `packages/app/plugins/android-assistant-entry/`, `packages/app/plugins/with-android-assistant-entry.js`,
    `packages/app/src/composer/quick-ask/use-quick-ask-voice.ts`.

70. **Dictation never sends, and a workspace left without a message is deleted** — the owner's
    rules on 2026-10-26. Every transcript lands in the composer, and only the send button sends:
    - The overlay keeps cancel and one confirm (check). The insert-and-send arrow is gone.
    - The keyboard confirm no longer sends.
    - Quick ask has no countdown and no "tap to edit" row.

    When the owner switches from a workspace to another one, the app asks
    `workspace.discard_empty.request` if the workspace has nothing in it. That means no agent,
    no terminal or browser tab, and no typed or sending draft. It never applies to the
    project checkout, a pinned workspace, or one renamed by hand. Screens outside a workspace
    do not count as leaving. The daemon re-checks the same rules plus archived agents and, for
    a Paseo-owned worktree, uncommitted or unpushed changes. It then removes the record: a
    worktree goes through the archive path first so its directory goes too. No archive entry
    remains. In a workspace that stays, empty new-agent tabs close on leaving, unless the tab
    is the last one. Gated by `server_info.features.discardEmptyWorkspace`. Key files:
    `packages/app/src/workspace/discard-empty-on-leave.tsx`, `packages/server/src/server/session.ts`
    (`handleWorkspaceDiscardEmptyRequest`), `packages/app/src/composer/input/state.ts`.

71. **Conversation text grows on its own, sidebar unchanged** — the owner's request on
    2026-10-26: over Parsec from a ThinkPad, the smaller screen made the conversation hard to
    read. A `chatTextScale` app setting (1–2, 10% steps; 1, the old size, is the smallest)
    becomes the theme token `chatTextScale` through `applyAppearance`. It multiplies the font
    size and line height of markdown (`createMarkdownStyles` and its compact variant), the
    user message text, and the composer input. Nothing else reads it, so the sidebar, headers,
    tool rows and settings keep their size. Controls:
    - Settings → Appearance → Fonts, a − / percent / + row.
    - Cmd+Option with + or − on macOS (a PC keyboard's Windows key arrives as Cmd over Parsec).
    - Ctrl+Alt with + or − elsewhere.
    - Cmd with + or − alone still zooms the whole window through the menu.
      The web composer re-measures its height when the scale changes, since no size observer
      sees a theme font change. Key files: `packages/app/src/styles/markdown-styles.ts`,
      `packages/app/src/screens/settings/appearance/`, `packages/app/src/keyboard/keyboard-shortcuts.ts`.
72. **Tables and long URLs read on a phone** — the owner's request on 2026-10-26, after a
    readability review of agent replies. Before, every table cell had `flex: 1`, so a
    four-column table on the phone split ~380dp four ways and wrapped prose a few letters per
    line. Now each column gets a basis from its widest cell, clamped to 3–7em (Hangul counts
    1em, Latin about half), and a grow share by content. A table whose bases exceed the screen
    scrolls sideways inside its border (persistent scrollbar on Android). A table that fits
    fills the width as before. Cells set `width` as well as `flexBasis`: on web a horizontal
    scroll container sizes to max-content, and a cell without a definite width stretched its
    text onto one line. A bare URL longer than 48 characters shows its host and a shortened
    path, with `?…`/`#…` for the query and fragment. Tapping still opens the full address, and
    on web the hover title and selection copy give the full address. Labelled links keep their
    label. Key files: `packages/app/src/components/markdown/table-columns.ts`,
    `packages/app/src/components/markdown/short-url.ts`, the `table`/`th`/`td`/`link` rules in
    `packages/app/src/components/message.tsx`, and the copy-text attribute in
    `packages/app/src/assistant-selection-copy/`.
73. **A running tool row ends in a blinking block caret** — the owner's pick (option A) on
    2026-10-27 after a deep research on working indicators. Before, a light gradient swept
    across the running row's text: a CSS `background-clip: text` sweep on web, an SVG gradient
    under a mask on native. That is Codex's look. The research covered other tools: Claude Code
    cycles stars with verbs, while Gemini CLI, OpenCode and Pi all spin the same braille dots.
    Now the label stays still and the row ends in an accent-colored block that blinks every
    530 ms, the way a terminal waits on a process. From 5 s on, the row's right edge shows the
    elapsed time in mono. The overview group header gets the caret without a time. Reduce
    motion keeps the caret solid, and a retained panel that is off screen stops ticking. A
    tool call's stream timestamp moves with every update, so `agent-stream/view.tsx` pins the
    first time the app saw each call running and drops the pin when it stops. The whole
    shimmer machinery is gone (measuring, keyframes, masked SVG); this replaces the delta 49
    note that reduce motion stills the shimmer. Previews of the four options are in
    `~/paseo-builds/preview/working-indicator.html`. Key files:
    `packages/app/src/components/message.tsx` (`RunningToolCaret`) and
    `packages/app/e2e/browser/tool-call-running-caret.spec.ts`.
74. **An agent's `create_agent` call succeeds on the first try** — the owner's report on
    2026-11-01 that research-worker launches "often" failed. A 30-day audit of Pi sessions
    (2026-10-02..11-01, 716 create calls) found the failures were spelling mismatches, not
    transport errors: 155 worker launches sent `prompt` (`send_agent_prompt` and
    `create_schedule` name the field that way), 18 sent an agent-scoped `cwd`, which routed to
    the legacy placement and failed with a raw schema dump, 5 sent a title over 60 characters,
    3 sent a Pi model id without the `pi/` provider, and 1 sent `settings.model`. Clients such
    as Pi's MCP adapter validate arguments against the advertised schema before sending, so
    the advertised input accepts these spellings and the handler maps them onto the canonical
    args before the strict parse: `prompt` becomes `initialPrompt` (both differing is an
    error), a longer title is cut to 60, `settings.model` completes a bare provider, a value
    whose prefix is not a registered provider gets the one provider that lists it as a model
    id, and an agent-scoped `cwd` runs the subagent there inside the caller's workspace. The
    result also carries its JSON as text, as the MCP spec asks of structured results, so a
    caller that parses text keeps the new agent's id. The tool-call detail shows a `prompt`
    exactly like `initialPrompt`. Key files: `normalizeCreateAgentInput` in
    `packages/server/src/server/agent/tools/paseo-tools.ts`, the "spellings models carry over"
    tests in `packages/server/src/server/agent/mcp-server.test.ts`, and `promptAlias` in
    `packages/protocol/src/paseo-tool-call-detail.ts`.
75. **Files open where the phone can show them, and every file has a tailnet link** — the
    owner's call on 2026-11-01 ("모바일에서도 미리보기를 최대한", "폰에서 보는거 싹다 궁극적으로
    개선"). Delta 62 sent every file on the phone to an Android app, and One UI 8 has no stock
    viewer for the files agents write most, so md, csv, json, and code ended in an empty chooser or
    a share sheet.
    - **Phone routing by extension, before any download** (`assistant-file-links/native-open-route.ts`).
      Markdown, HTML, plain text, logs, data (csv, tsv, json, jsonl, ndjson, yaml, toml, sql, …),
      and source open in the file pane: markdown rendered, HTML in the sandboxed WebView, the rest
      highlighted. png, jpg, gif, and webp open in the zoomable image view. Everything else keeps
      delta 62: pdf, office, HWP, iWork, media, archives, databases, and unknown extensions. SVG,
      HEIC, BMP, TIFF, and ICO stay external too: the daemon reads only png/jpg/gif/webp/svg as
      images and React Native cannot decode SVG, so the pane would show nothing where the gallery
      or Chrome shows the picture. A folder expands Files and a missing path gives a toast
      (delta 90).
      Dotfiles (`.gitignore`, `.zshrc`, every `.env.<stage>`) and well-known text names without an
      extension (`Makefile`, `Dockerfile`, `README`, `LICENSE`, `CHANGELOG`, `Procfile`, …) open in
      the pane too; any other extensionless name stays external. This rule shipped in the 0.5.86
      APK; the Mac app stays 0.5.85 for this delta, since it never uses the phone route.
    - **File pane actions on the phone** (`file-pane/file-actions.tsx`; the `.web.tsx` twin renders
      nothing, so web and the Mac app are unchanged): a `…` menu in the pane bar with "다른 앱으로
      열기" (the delta 62 download and view intent), "공유" (the same download into the share
      sheet), and "링크 복사" when the host has preview links.
    - **Tailnet preview links.** The daemon serves `GET /f/<token>/<name>` inline: Chrome renders
      PDF, HTML, images, video (Range requests), audio, and text; markdown becomes a self-contained
      HTML page (`file-preview/markdown-page.ts`); office, HWP, and archives download and Android
      offers an app. Tokens are 128-bit, reusable, 30 days by default, and persisted as hashes in
      `~/.paseo/preview-links.json`. A link is issued only for a regular file under home or temp
      space and the check repeats on every request. The route sits before the daemon password and
      accepts the allowlisted hosts plus the preview host (threat model in `SECURITY.md`). Two ways
      in: the agent tool `preview_link` (`{ path }` → `{ url, expiresAt, fileName, mimeType }`), and
      the app's "링크 복사" over `fs.preview_link.create.request`, gated on
      `server_info.features.previewLinks` (true only when a base URL is set).
    - **Setup on this Mac.** `~/.paseo/config.json` carries
      `"previewLinks": { "baseUrl": "https://mac.tail29eaf5.ts.net/f", "ttlDays": 30 }` under
      `daemon` (env `PASEO_PREVIEW_LINKS_BASE_URL` / `PASEO_PREVIEW_LINKS_TTL_DAYS` win), applied by
      `paseo daemon reload` without a restart. The config schema is strict, so a daemon older than
      this delta refuses to start with the key in place: remove it before rolling back. Tailscale
      Serve mounts the route tailnet-only with
      `Tailscale serve --bg --set-path=/f http://127.0.0.1:6767/f` (the CLI is
      `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; rollback `serve --set-path=/f off`).
      The `/` mount for the APK folder stays as it is.
    - **Mac fix.** A link with a line reference (`report.pdf:3`, `notes.md:12`) now reaches the
      Electron opener as `reveal`, so it is selected in Finder as delta 62 says instead of opening
      in its app.
    - **Key files:** `packages/server/src/server/file-preview/`,
      `packages/app/src/assistant-file-links/native-open-route.ts`, `use-file-link.ts` and
      `use-open-file-externally.ts` beside it, `packages/app/src/file-pane/file-actions.tsx`,
      `packages/desktop/src/features/opener.ts`, and the daemon test
      `packages/server/src/server/daemon-e2e/preview-links.e2e.test.ts`.
76. **A scheduled run keeps its session** — the owner's call on 2026-11-02 ("세션들 다 기본값
    남았으면": an archived run hides what it did and how it ended). Upstream archives a
    new-agent run's workspace at its first idle unless the schedule sets `archiveOnFinish:
false`; that default is now `false` in the daemon (`schedule/service.ts`
    `shouldArchiveScheduleRunWorkspace`) and in the schedule form's initial state. A run that
    produced no agent still archives its empty workspace; `archiveOnFinish: true` still archives
    as before, and the `Archive on finish` switch in the form sets it explicitly. The seven
    schedules active on 2026-11-02 were set to `false` over `schedule/update` the same day
    (the MCP `create_schedule`/`update_schedule` tools and the CLI carry no archive flag; the
    app form and the RPC do). Tests: `service.test.ts` "a schedule that says nothing about
    archiving keeps its run session", `schedule-form-model.test.ts` create defaults.
77. **Claude plans carry their current names** — the owner's request on 2026-11-02. Anthropic
    renamed Max 20x to Ultra and Max 5x to Max on 2026-10-30, but the OAuth credential still
    says `subscriptionType: "max"` with the old tier (`default_claude_max_20x`), so the provider
    usage card read "Max 20x". `buildClaudePlan` in
    `packages/server/src/services/quota-fetcher/providers/claude.ts` maps `max` + `20x` to
    `Ultra` and `max` + `5x` to `Max`; every other plan keeps upstream's `<Type> <tier>` label.
    Test: `service.test.ts` "labels the old Max 20x and Max 5x credentials by their current
    names".

78. **Passkeys work in the browser, served by an agent-owned software authenticator** — the
    owner's request on 2026-11-02 after a ChatGPT sign-in asked for a passkey and nothing
    happened. Measured: Electron enables no platform authenticator, so a page's
    `navigator.credentials.get()` hung with no dialog past its own timeout; the macOS passkey
    sheet (iCloud Keychain, 1Password) is out of reach because Chromium gates it on Apple's
    `com.apple.developer.web-browser.public-key-credential` entitlement and Electron 45's
    `platformPasskeys` serves only an app's own associated domain. Every browser webview and
    popup now gets Chromium's CDP virtual authenticator (`WebAuthn.enable` +
    `addVirtualAuthenticator`: ctap2, internal transport, resident keys, user verification,
    backup flags) re-installed on every main-frame commit. Chromium 146 (Electron 41) drops the
    environment on each navigation; Chromium 152 (Electron 44) keeps it and refuses a second
    internal authenticator, so each reinstall first removes the tab's previous one (delta 82).
    Credentials a site registers arrive through
    `WebAuthn.credentialAdded` and are kept in `userData/browser-passkeys.json` (0600, private
    keys `safeStorage`-encrypted) and added to every other open tab; `credentialAsserted`
    updates the counter everywhere so no tab signs with a stale count; the browser profile
    session's `select-webauthn-account` answer is required (Electron cancels a discoverable get()
    without it). Since delta 102 that answer signs in only on request: page load never signs in,
    and the "most recently used" pick is gone. A site with no stored passkey fails in a
    few ms with `NotAllowedError` instead of hanging, so the agent takes the password or code
    route. New MCP tool `browser_passkeys` (`list` / `status` / `delete`; never the keys).
    `PASEO_BROWSER_PASSKEYS=0` turns it off. Key files:
    `packages/desktop/src/features/browser-automation/passkeys.ts`, the `passkeys` branch in
    `service.ts`, `configureBrowserPasskeys` in `packages/desktop/src/main.ts`,
    `packages/protocol/src/browser-automation/rpc-schemas.ts`, `browser_passkeys` in
    `packages/server/src/server/browser-tools/tools.ts`. Tests: `passkeys.test.ts`, protocol and
    tools tests, and the real-Electron `passkeys` capture-harness group (register, sign in from
    another guest and after a navigation, status, delete).
    The store never asks `safeStorage` at startup: its first call reaches the macOS keychain
    synchronously on the main thread and can wait on a keychain prompt, and asked from
    `configureBrowserPasskeys` (before any window) it kept 0.5.88 from opening a window, so the
    GUI render smoke failed and 0.5.88 never activated (measured 2026-11-04 with `sample`: main
    thread in `SecItemAdd` → `AuthorizationCopyRights`). The cipher is asked when a passkey is
    added or the storage mode is reported; an existing file's `encrypted` flag is read from disk.

79. **History finds sessions by what was said and what was meant, and leaves sub-agents out** —
    the owner's request on 2026-11-04 after measuring that 1,689 of 2,488 agent records (68%) were
    agents another agent created and that title-only search found 0 of 18 sessions described in a
    sentence. Plan: `~/.pi/agent/plans/-Users-ddgk/2026-11-04-daseo-history-search.md`.
    - **Sub-agents hidden.** History lists and searches only agents without
      `paseo.parent-agent-id` unless the request sets `includeSubagents` (the "Include sub-agents"
      switch). Absent means hidden for every client, so an older phone app also stops listing
      workers; its parsing is unaffected. Detached agents and scheduled runs stay visible.
    - **Message bodies.** An index (`$PASEO_HOME/search/history-index.sqlite`, `node:sqlite` FTS5
      trigram) holds the owner's messages and the assistant's answers of every root session —
      never tool output, reasoning, or `origin: "system"` prompts. Trigram cannot match 1–2
      character tokens ("규칙"), so those fall back to a LIKE scan. Contiguous assistant rows are
      joined into one message as the app renders them: some timelines stream one answer as
      hundreds of chunk rows (the first real build held 532,674 "messages" averaging 20 chars;
      joined, 24,280 averaging 463). Sessions from before Paseo timelines (152 on this Mac) are
      read from the Pi session file in `persistence.nativeHandle` through `PiHistoryMapper`.
      The first build runs in the background 5 s after start (799 roots, 138 s measured, 30,954
      messages, 12.3 MB); queries take 1–100 ms including snippets. After
      that each committed timeline change syncs only that agent and only the new rows
      (`FileBackedAgentTimelineStore.onCommittedChange`), and a record write that changes whether an
      agent is a root session (a detach rewrites labels and nothing else; a new agent exists before
      its first row) syncs it too (`AgentStorage.onRecordChanged`). The file is a derived cache: delete it to
      rebuild; a schema change rebuilds.
    - **Meaning.** `multilingual-e5-small` (q8 ONNX, 384 dims, Hub revision `761b726d`, sha256
      pinned) downloads once into `$PASEO_HOME/models/history-search/` and runs only in a separate
      worker process (`Paseo History Search`, about 520 MB resident, started on demand, stopped
      after 5 minutes idle, batches of 8, lowered CPU priority). Sessions are up to 12 evenly
      sampled 1,000-char windows; a session scores as its best window. Runtime is
      `onnxruntime-node` 1.21.0 + `@huggingface/tokenizers` directly rather than
      `@huggingface/transformers` (which adds onnxruntime-web and sharp); token ids are identical
      and single-text vectors match transformers.js at cosine 1.000000. `sherpa-onnx-node` has no
      generic ONNX session, so it cannot host this model. `after-pack.js` keeps only the target's
      `onnxruntime-node/bin/napi-v3/<platform>/<arch>`. Checked under Electron 41's own runtime
      (`ELECTRON_RUN_AS_NODE`): ONNX Runtime loads and embeds, and `node:sqlite` has FTS5 trigram;
      a packaged build was not made for this delta. Until the model is ready, search is keyword-only
      and the screen says so.
    - **Ranking.** Title (the existing ranker), body keyword (BM25, a message as the unit of term
      frequency, OR across words), and semantic (top 30) are fused by reciprocal rank (k = 60). A search waits at most 1.5 s for the semantic list
      (measured: warm query 2–3 ms, cold worker 508 ms, queued behind an 8-passage batch 584 ms); past
      that it answers with title and keyword results (rows carry no `semantic` source) while the query
      embedding finishes and warms the worker.
      `searchScore` is `1 / rrf` so multi-host merging still sorts ascending. Each result carries
      `searchSnippet` (best message, marked ranges, `seq`, and `anchorSeq` = the user row that
      starts its turn) and `searchSources`.
    - **Opening at the message.** A row press records `anchorSeq` in
      `stores/timeline-jump-store.ts`; the stream view loads that window and scrolls there
      (`useTimelineSeqJump`, extracted from the chat outline). Only user rows carry timeline
      positions in the app, so an answer opens at the prompt of its turn. Native gained
      `scrollToMessage` (inverted FlatList, `viewPosition: 1`).
    - **"AI로 찾기".** `agent.history.ai_rank.request` sends the top 20 to the metadata model
      (Luna low, same selection as workspace auto-titles) with a card per session (title, date,
      first owner message, last answer, matching passage). Only on the button, 20 s server timeout;
      failure keeps the plain order with a one-line notice.
    - **Status.** `agent.history.get_search_status.request` reports keyword `indexing n/N` and
      semantic `downloading | indexing | ready | failed`; the screen polls it every 3 s only while a
      query is typed and the index is still building, and refetches once it settles.
    - **Gates.** `server_info.features.agentHistorySubagentFilter`, `agentHistoryContentSearch`
      (false when `node:sqlite` is missing, Node < 22.5), `agentHistoryAiRank`. Env
      `PASEO_HISTORY_SEARCH=0` turns content search off, `PASEO_HISTORY_SEMANTIC=0` keeps it
      keyword-only; there is no config.json key, so a rollback never meets an unknown key. Test
      daemons leave it unset and keep title-only search.
    - **Key files:** `packages/server/src/server/history-search/`, `listFetchAgentsEntries` and
      the two handlers in `session.ts`, `packages/app/src/hooks/use-agent-history*.ts`,
      `screens/sessions-screen.tsx`, `components/agent-list.tsx`,
      `agent-stream/use-timeline-seq-jump.ts`. Tests: `history-search/*.test.ts` (synthetic
      18-topic fixture in `test-utils/`, never real transcripts), the real-model
      `semantic/history-semantic.local.e2e.test.ts` (skipped unless the model is installed or
      `PASEO_HISTORY_E2E_DOWNLOAD=1`), `messages.history-search.test.ts`, and the sub-agent case in
      `session.workspaces.test.ts`.

80. **A report for the lead gets through, and one finish is one notice** — the owner's report on
    2026-11-05: a phase-10 implementer ended its turn at 11:20 KST with "waiting for the lead's QA"
    while its own HYM push-gate wait was still pending, delta 29 kept "finished" quiet, the lead
    never heard, and the owner typed "GO" in the child's tab, skipping the lead's review. Separately,
    a lead that sent seven follow-ups to a running implementer on 2026-11-04 received the same finish
    notice seven times, because every `send_agent_prompt` with notify-on-finish added a watcher.
    - **`[lead review]`.** When a child goes idle with background waits pending and its last
      message has a line that is exactly `[lead review]` (any case), the caller gets a non-terminal
      "is waiting for your review" notice with that message, once per distinct message, and the
      watch continues. The later finish is delivered only if the child then says something other
      than that report or `[wait noted]`; otherwise the watcher ends quietly and leaves the journal.
      Without the marker delta 29 is unchanged (a child that ends its turn to let a build run stays
      quiet). pi-local's delegate-implementation skill tells implementers to end every stop for the
      lead with the marker.
    - **One watcher per (child, caller).** A new watcher for the same pair stops the previous one
      in memory (the journal entry is shared and stays). Delta 106: it refreshes the live one.
    - **Key files:** `packages/server/src/server/agent/agent-prompt.ts` (`asksForLeadReview`,
      `liveFinishWatchers`, `reportReviewIfAsked`, `finishAfterReview`), tests in
      `agent-prompt.test.ts` ("lead review and one watcher per pair"). Takes effect with the next
      release and daemon restart.
81. **The browser keeps Electron's own user agent, so Cloudflare's human check passes** — the
    owner's report on 2026-11-06: signing in at dash.cloudflare.com in Daseo showed "There was a
    problem with verification", the Turnstile widget failed with 600010 and was recreated about
    every 1.2 s, and Sign in stayed disabled; debug.challenges.cloudflare.com still said "No
    automation detected". Delta 26's plain Chrome string was the cause. A bare Electron 41.10.6
    harness on the same Mac and network, fresh profile per run: the native string (with or without
    the `Paseo/<v>` token) passed 5 of 5 (`cf_challenge_response` 752-773 chars, no 600010), the
    stripped string failed 2 of 2 (600010 15-16 times, empty response). t3code PR #7110 measured
    the same on Linux with Electron 41.5 and 44.1. Google sign-in reached the password step with
    both strings; steps after the password were not checked. Ruled out: a dedicated worker reports
    the same user agent as the page, and the harness had no debugger attached.
    - The profile session keeps `session.getUserAgent()` and only passes delta 65's
      Accept-Language list to `setUserAgent`. Client hints stay Chromium-only, matching an
      Electron user agent. Device emulation still overrides per tab.
    - **Key files:** `packages/desktop/src/features/browser-profile.ts`
      (`applyPaseoBrowserProfileUserAgent`), `packages/desktop/src/main.ts`, test in
      `browser-profile.test.ts`. Takes effect with the next release (the session is configured at
      app start).

82. **Electron 44** — the owner's call on 2026-11-06 to leave Electron 41, which reached end of
    support. Daseo moves to the latest 44.x (44.10.2, Chromium 152) rather than 45, because
    upstream Paseo ships 44.2.0 (#4322, 41.2.0 → 44.2.0 in one step) and 45 removes globals
    from sandboxed preloads. Hand-ported from #4322: the main-process clipboard moves to
    Electron 44's W3C `clipboard.read()`/`write([ClipboardItem])` (the old `readImage`,
    `writeImage`, and object `write` are gone; text and image are written as one item), the
    profile clear swaps the removed `websql` storage type for `shadercache`,
    `minimumSystemVersion: "13.0.0"` (Electron 44 needs macOS 13), and the desktop test script
    runs `install-electron` first (Electron 42 dropped the postinstall download; `require("electron")`
    still downloads on first use). The updater diagnostics in #4322 are not carried: Daseo ships
    no updater.
    - **Fork-only changes the upgrade needed.** Electron 43 opens a file dialog without
      `defaultPath` in Downloads instead of the folder last picked from; the open dialog now
      remembers the last selection's folder for the app session (the first dialog after launch
      starts in Downloads). Passkeys: the virtual authenticator now survives navigations (see
      delta 78), so the reinstall removes the previous one and a half-loaded authenticator is
      removed on failure; on 44 without this the `passkeys` harness group failed with "Chrome only
      supports one internal authenticator per environment" and a tab kept serving stale counters.
    - **Verified on 44.10.2:** capture-harness groups `permanent-parking`, `automation`,
      `passkeys`, `frames-network`, `debugging`, `tab-lifecycle` pass; under
      `ELECTRON_RUN_AS_NODE` ONNX Runtime loads the History model, `node:sqlite` FTS5 trigram
      matches, and node-pty spawns. The `browser-profile` group times out on `did-attach` on 41.10.6
      too, so it is not a 44 regression. The `automation` group's focused-iframe shortcut check
      failed once in five 44 runs (zero in five on 41): the iframe receives the shortcut policy by an
      asynchronous request after its preload starts, and the check presses the key right after the
      frame loads.
    - **Key files:** `packages/desktop/package.json`, `electron-builder.yml`, `src/main.ts`
      (copy-element, clipboard image), `src/features/clipboard-image.ts`,
      `src/features/dialog-directory-memory.ts`, `src/features/dialogs.ts`,
      `src/window/window-manager.ts`, `src/features/browser-profile.ts`,
      `src/features/browser-automation/passkeys.ts`, with their tests and
      `src/daemon/desktop-packaging.test.ts`.

83. **A Pi dialog that closes on its own closes in Daseo too** — the owner's report on
    2026-11-07: after `/claude-auth login` finished through the browser, the "paste the
    authorization code" card stayed on screen. Pi's RPC mode settles a dialog whose extension
    AbortSignal fires, or whose timeout passes, inside Pi without telling the client, so the
    request stayed in `pendingExtensionUiRequests`. pi-local now patches the installed Pi core
    (`scripts/pi-core-patches.mjs`, applied by its bootstrap after every Pi install) to print
    `{"type":"extension_ui_dismissed","id"}` at both settle points; the Pi provider deletes the
    pending request and emits `permission_resolved` (deny, "Dismissed by Pi"), which removes the
    card on every client. Stock Pi never sends the event, so nothing changes without the patch.
    - **Key files:** `packages/server/src/server/agent/providers/pi/agent.ts`
      (`handleExtensionUiDismissed`), test in `agent.test.ts`. Daemon-only; takes effect with
      the next Mac release, no APK needed.
84. **Under memory pressure, idle agents unload after 30 minutes instead of 60** — the owner's
    2026-11-07 RAM review (24 GB Mac, 155 pressure warnings in 20 days). Lowering delta 33(d)'s
    60 minutes to 30 everywhere was measured and rejected: a Pi resumed after 30-60 idle minutes
    still read a median 94.8% of its prompt from cache (8 daemon-restart resumes vs 94.97% for
    212 that stayed alive), but the Claude bridge's keep-warm request (53 minutes after the last
    request, contexts over 100k) runs inside the Pi process and dies with it, so 30 minutes would
    end every keep-warm and turn 60-113-minute returns into full cache rewrites, for about 0.2 GB
    saved on average. So, like delta 43 for tabs, only while the macOS pressure level
    (`kern.memorystatus_vm_pressure_level`) is 2 or 4 does the sweep use
    `agents.pressureIdleUnloadMinutes` (default 30; 0 turns it off; ignored when not shorter than
    `idleUnloadMinutes`, and nothing unloads when `idleUnloadMinutes` is 0). Every delta 33(d)
    blocker still applies. The level is read only when some agent is idle between the two
    thresholds; a pressure-driven sweep logs `idle_agent_unloader.memory_pressure`.
    - **Key files:** `packages/server/src/server/agent/idle-agent-unloader.ts`
      (`readMemoryPressureLevel`, `DEFAULT_PRESSURE_IDLE_UNLOAD_MINUTES`), `bootstrap.ts`,
      `config.ts`, `persisted-config.ts`; tests in `idle-agent-unloader.test.ts`. Daemon-only;
      takes effect with the next Mac release, no APK needed.
85. **Coupang links open in the Coupang app on the phone** — the owner's report on 2026-11-08:
    tapping a Coupang product link (`https://www.coupang.com/vp/products/<id>`) in an agent
    answer opened the default browser, and Coupang answered with its block page ("입력하신
    페이지주소는 사용권한이 제한된 페이지입니다") from the phone's mobile-carrier IP. The link was right;
    Coupang blocks the browser. On Android, `openExternalUrl` now first offers an http(s) link
    whose host is in `ANDROID_APP_LINK_PACKAGES` to that app: today only `coupang.com` and its
    subdomains → `com.coupang.mobile`. Add other shops to that table only.
    - **Share-link rewrite.** On the Fold with 0.5.96 (owner, 2026-11-08 evening), `www`
      `/vp/products/<id>` and `m` `/vm/products/<id>` links still opened the browser, while
      `https://link.coupang.com/re/CSHARESDP?pageKey=<id>` opened the product in the app: the
      app's filters take only `link.coupang.com`, the one host whose `assetlinks.json` lists
      `com.coupang.mobile`. So `toAndroidAppUrl` turns those two product-page shapes into the
      app's own share-link form, carrying `itemId` and `vendorItemId` when they are all digits,
      and adds no `lptag` or other affiliate parameter. Other Coupang links go to the app as
      they are. The browser fallback always gets the original URL, so a phone without the app
      sees the normal product page, not a share redirect.
    - **Mechanism.** The local module `DaseoAppLinks` starts a VIEW intent with `setPackage`,
      `CATEGORY_BROWSABLE`, and `FLAG_ACTIVITY_NEW_TASK`. Naming the package lets the app's own
      link filter take the URL even without a verified App Link, and keeps the browser and the
      chooser out. When the app is missing or has no activity for the link
      (`ActivityNotFoundException`), or the call fails, the link goes once to `Linking.openURL`,
      the browser path from before. `expo-intent-launcher` cannot do this: it applies
      `packageName` only together with an activity class name, and its `startActivityForResult`
      promise stays pending until the opened app returns.
    - **Not changed:** iOS (the module is Android-only), the Mac app and web (the `isWeb` branch),
      other links, and the file routing of delta 75.
    - **Not verified here:** the tap on a rewritten product link (no ADB access); the evidence is
      the owner's tap on a hand-written share link. Search and category links are not
      rewritten; since the app's filters take only `link.coupang.com`, expect them in the
      browser.
    - **Key files:** `packages/app/src/utils/android-app-links.ts` (table, resolver, rewrite),
      `open-in-android-app.ts`, `open-external-url.ts`, tests in `android-app-links.test.ts` and
      `open-external-url.test.ts`, and `packages/app/modules/daseo-app-links/`. Shipped in APK
      0.5.96, share-link rewrite in 0.5.97; the Mac app is unaffected.

86. **The phone stops paying for Daseo when nobody looks at it, and the sidebar crash is gone** —
    the owner's report on 2026-11-09 (battery, "error when I open it"), measured on the Fold 7.
    With Daseo last on screen and the screen off, the process stayed `TOP_SLEEPING` (not cached,
    not frozen) and kept receiving and rendering the live agent stream: 2.3–3.1 CPU-s per minute
    on the main thread, peaks of 25 CPU-s per minute while agents streamed, 771 mAh of screen-off
    CPU in one day, and two `excessive cpu` kills. Separately the whole app fell into
    RootErrorBoundary nine times (10-26..11-09) with "Unable to find node on an unmounted
    component", stack `attachHandlers` → `MountRegistry.gestureWillMount` → `forEach` →
    `updateDetector` → `findNodeHandle` under `MobileSidebar`'s `GestureDetector`.
    - **Crash.** react-native-gesture-handler's mount listener (`useMountReactions`) updates every
      detector whose gesture is related (`simultaneousWith`, `requireToFail`, `blocksHandlers`)
      to a gesture that is mounting. When one detector unmounts and a related one mounts in the
      same commit, React runs the old detector's layout cleanup (`isMounted = false`) before the
      new one's `attachHandlers`, but removes the old listener only with passive effects, so the
      listener calls `findNodeHandle` on an unmounted component. Upstream fixed it in
      software-mansion/react-native-gesture-handler#4268 (2.33.0) with an `isMounted` guard;
      `patches/react-native-gesture-handler+2.28.0.patch` carries that guard in `src`,
      `lib/module` and `lib/commonjs`. Upgrading to 2.33 was rejected for now (unverified with
      RN 0.81.5, Expo 54, Reanimated 4.3, and the existing Android orchestrator hunks). Regression
      test: `packages/app/src/mobile-panels/rngh-mount-reactions.test.tsx` reproduces the
      commit order with the real `useMountReactions` and fails without the guard.
    - **Background suspend.** 30 s after the native app stops being visible (AppState not
      `active`), every host connection is suspended: `DaemonClient.suspend()` drops the
      transport and stops reconnecting but keeps the client, its listeners and subscriptions;
      the host reads `idle` (not offline or error, so no reconnect toast and no error state).
      Showing the app again resumes at once with `ensureConnected()`, and the host's normal
      online transition re-bootstraps the directories and catches the viewed timelines up, the
      same path as a dropped relay. Probing and connection switches wait while suspended. A
      return within the grace (a permission or credential prompt, copying a code) never
      disconnects. Dictation and voice sessions hold the connection until they end. Web and
      Electron never suspend (`index.ts` is a no-op; `index.native.ts` does the work).
    - **Why a native timer.** React Native's JS timers run on Choreographer frames and stop at
      `onHostPause` (`JavaTimerManager`), so a JS `setTimeout` started on leaving the screen
      would fire only on return. The local module `DaseoBackgroundSuspend` runs the grace on a
      main-looper `Handler` and emits an event; socket messages and module events still reach JS
      while paused, which is why the stream kept costing CPU.
    - **The 60 Hz loop that ran with the screen off.** With the Activity stopped and no frame
      drawn, the main thread still woke about 62 times a second (1.3 CPU-s per minute even
      when no host was connected). simpleperf on a `PASEO_PROFILE_BUILD=1` APK put half of all
      main-thread samples in `worklets AnimationFrameQueue.executeQueue`, the UI-runtime
      `requestAnimationFrame` queue: worklets 0.8.3's `WorkletsModule` implements
      `onHostPause` but never registers itself as a lifecycle listener, so the queue never
      pauses. `patches/react-native-worklets+0.8.3.patch` backports
      software-mansion/react-native-reanimated#10196 (worklets 0.10.4/0.12: register in
      `initialize`, unregister under a lock in `invalidate`) and adds one thing upstream lacks:
      React Native replays only `onHostResume` to a listener added late, so a module
      initialized while the Activity is not resumed (a cold start behind the lock screen)
      starts its queue paused. Remove the patch when worklets reaches 0.10.4.
    - **Known remaining cost (not fixed): cold start behind the lock screen.** Started with the
      screen off and the keyguard up, the host resumes and pauses 20 ms apart while React is
      still being created. `ReactContext.addLifecycleEventListener` replays `onHostResume` to a
      listener added while the state is `RESUMED` through a UI-thread runnable that does not
      re-check the state, so a listener registered in that window (React Native's
      `JavaTimerManager`) gets the pause first and the stale resume after it, and keeps its timer
      frame callback posting at the display rate: about 62 main-thread wakeups a second,
      0.6–0.9 CPU-s per minute, 3 of 3 cold starts on the Fold 7 (2026-11-09). It lives in the
      prebuilt `react-android` AAR, which a patch-package source edit cannot reach; a candidate
      for an upstream React Native report. A normal "used, then screen off" pause is unaffected.
    - **Memory on suspend.** React Native runs a Hermes collection only on
      `TRIM_MEMORY_BACKGROUND` or worse, which an app left on top with the screen off never
      gets, so delta 63's stale shadow-node revisions stay alive. On suspend the same module
      raises `TRIM_MEMORY_RUNNING_CRITICAL` through `MemoryPressureRouter`, as delta 63's
      watchdog does. Measured by hand on 0.5.97 (9.7 h process, backgrounded): native heap
      allocated 360 → 267 MB, TOTAL PSS 745 → 674 MB; Views unchanged at 6,974.
    - **Measured on the Fold 7 (0.5.98, 2026-11-09).** The daemon logged the phone's disconnect
      30–31 s after every departure in his own use (16:26:02 → 16:26:33, 16:42:26 → 16:42:56,
      17:08:57 → 17:09:27); a fold mid-use (Activity recreated in 2 s) kept the connection.
      Returning reconnected in under 1 s (16:43:13.5 → 16:43:14) with the timeline on screen at
      once and no error, offline banner or reconnect toast. Pushes sent while suspended reached
      the phone 1 s later (16:28:15 → 16:28:16, 16:29:12 → 16:29:13). Out of view after the
      grace: 0 CPU ticks per minute for three minutes (17:13–17:15, another app in front).
      Memory of one process, in view → 30 s after leaving: TOTAL PSS 699 → 596 MB, native heap
      280 → 220 MB, Views 3,125 → 2,629. No RootErrorBoundary report since 0.5.98 was
      installed. Still a large foreground cost while in use (main thread 30–43 CPU-s per
      minute): upstream software-mansion/react-native-reanimated#10553, the UI-runtime frame
      loop re-arming every frame while visible, is one candidate; not part of this delta.
    - **Sidebar rows without a kebab (owner's report the same day): not reproduced.** On 0.5.98 the
      Fold showed the ⋮ kebab on every workspace row unfolded (project and status grouping),
      right after a suspend and resume, and on the cover screen. In code every row renderer
      (project, status, pinned) passes its archive action, and on touch the kebab hides only
      under the keyboard-shortcut badge, which Android never raises. The shared rule moved to
      `packages/app/src/components/sidebar/trailing-action-visibility.ts` so
      `sidebar-workspace-trailing-actions.test.ts` pins it without React Native: on a touch
      screen every row with row actions shows the kebab and reserves its width, whatever the
      trailing preference or row content. A next sighting needs a screenshot of that sidebar.
    - **Not changed:** server, protocol, relay, desktop and web behavior; push still comes from
      the daemon's presence policy (a suspended phone is not a connected client).
    - **Key files:** `packages/app/src/runtime/background-suspend/` (`controller.ts` grace and
      holds, `index.native.ts` wiring), `HostRuntimeController.suspend/resume` and
      `HostRuntimeStore.setBackgroundSuspended` in `packages/app/src/runtime/host-runtime.ts`,
      `DaemonClient.suspend` in `packages/client/src/daemon-client.ts`,
      `packages/app/modules/daseo-background-suspend/`, `patches/react-native-worklets+0.8.3.patch`
      (registered in `scripts/postinstall-patches.mjs`), tests in `controller.test.ts`,
      `host-runtime.test.ts` and `daemon-client.test.ts`.

87. **The phone stops redrawing the whole screen for a spinning ring** — the owner's request on
    2026-11-09 after the foreground profile: Daseo used 72 CPU-s per minute with a finished
    conversation on screen, 77 with an agent running quietly and 90 while text streamed
    (KakaoTalk averages about 7), with 82–95% janky frames while agents ran. simpleperf on a
    profileable 0.5.99 put 85% of the main thread under `NodesManager.performOperations` →
    `ShadowTree::commit` → Yoga `layoutTree`: every frame, the status rings' rotation and the
    loader dots' opacity were committed to the shadow tree and the whole screen was laid out
    again (Yoga's pixel rounding showed up as `fmod`). Streaming added a React commit every
    display frame from delta 51's paced reveal.
    - **Fast path for animated styles.** `packages/app/package.json` turns on Reanimated's
      static flag `ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS` (Reanimated 4.0+, off by default):
      transform, opacity and colours apply to the native view without a commit or layout.
    - **Tap targets stay where they are drawn.** With the fast path the shadow tree lags behind
      a view that slid, and React Native's Pressability measures from the shadow tree, so a
      pressable inside it can lose `onPress` on the first touch move (Reanimated documents
      this; settled styles re-sync only after a second). In `performOperations` Reanimated
      takes a view off the fast path as a whole when its animated style holds any property
      outside the fast-path set, so `SHADOW_TREE_COMMIT_PIN` (`backfaceVisibility: "visible"`,
      Android's default) keeps every container that moves pressables committed: the mobile
      sliding panels, keyboard-shifted composers and callouts, the autocomplete popover, and
      gorhom's sheet body (`patches/@gorhom+bottom-sheet+5.2.14.patch`; every phone menu is a
      sheet). `reanimated-commit-path.test.ts` pins the three source facts this relies on.
    - **Rings turn only where they can be seen.** A ring now follows the shared clock through
      its own value, only while its retained panel is active and reduce motion is off (the
      loader's pattern), so rings in hidden workspaces or a closed sidebar neither keep the
      clock running nor update on its frames, and reduce motion holds every ring still.
    - **Paced text commits at about 30 Hz.** The reveal still advances one line unit per
      display frame, but the shown text reaches React only when 30 ms have passed since the
      last commit, carrying the units of the frames in between; catch-up, thresholds and
      hysteresis are unchanged, and text arriving after the reveal caught up shows on its
      next frame.
    - **Not changed:** what the screens show and how they move; web and Electron (the flag is
      Android-only, the ring clock is the native implementation); worklets' idle frame loop
      (react-native-reanimated#10553, fix PR #11237 still open).
    - **Measured 2026-11-09 on the Fold 7** (profileable build of the delta commit, same
      scripts and screens as the 0.5.99 profile; CPU-s per minute, minute 1 / minute 2):
      finished conversation 72.3 → 44.8/45.1 (main thread 50.0 → 14.9, RenderThread 18.5 →
      27.4, jank 10% → 0.18% of 14,561 frames); agent running quietly 77.0 → 52.2/49.1 (jank
      82% → 0%); streaming 90.2 → 70.3/78.4 (JS 35.9 → 26.0/33.3, jank 95% → 0%); streaming
      with reduce motion 73.6 → 38.4/38.7 (RenderThread 22.5 → 2.3: rings hold still). The
      streamed text area changed 388 times in 11.94 s of screen recording (32.5 Hz). What is
      left: drawing the turning rings at a full 120 Hz (RenderThread, about 70% `libhwui`),
      and on every drawn frame Android's text-field cursor-position listener
      (`Editor$PositionListener.onPreDraw` → `getLocationInWindow`, about 30% of the main
      thread) plus Reanimated's frame callback (about 30%); while streaming, each text commit's
      React reconcile, `ShadowTree::commit` and Yoga layout on the JS thread (about 35% and
      20%). The plan's targets (15, 20 and 40) were not reached.
    - **Taps verified on the cover screen** (compact layout): workspace rows right after the
      sidebar slid in (the slide takes about 0.1 s at animation scale 0.5), the row kebab, its
      sheet's "Copy path" 0.2 s and 0.35 s after the kebab, tapping outside a sheet, the
      sidebar's settings, back and close buttons, the file panel's entries and close button,
      and the attachment button of the keyboard-shifted composer. A tap 0.1 s after the kebab
      lands before the sheet has entered and does nothing.
    - **Key files:** `packages/app/src/utils/reanimated-commit-path.ts`,
      `packages/app/src/components/status-ring/clock.ts`,
      `packages/app/src/agent-stream/{stream-pacing.ts,use-paced-stream-text.ts}`, tests in
      `clock.test.ts`, `use-paced-stream-text.test.ts`, `stream-pacing.test.ts` and
      `reanimated-commit-path.test.ts`.

88. **Android status rings turn on the RenderThread** — the owner approved on 2026-11-09
    (round 2 of the foreground CPU work) after 0.5.100 still spent 45 CPU-s per minute with a
    finished conversation open, mostly waking the main thread for every ring frame: the
    composer's cursor-position pre-draw listener (`Editor$PositionListener`, about 30%) and
    Reanimated's frame callback (about 30%).
    - **What changed.** On Android the ring's turning quarter is a native view
      (`modules/daseo-status-ring`) drawing an `AnimatedVectorDrawable`, which animates on the
      RenderThread since API 25. Once started, no ring frame touches the main thread, the JS
      thread or Reanimated. The frame (knockout, track, centre dot) is still the shared React
      Native view in `frame.tsx`. iOS keeps the Reanimated clock (`index.tsx`, `clock.ts`), web
      keeps `index.web.tsx`.
    - **Same look.** The vector path is what React Native's `BorderDrawable` draws for a lone
      top border on a fully rounded 12 dp box: the band between radius 6 and 4.5 dp, cut along
      the diagonals (225° to 315°), fill alpha `STATUS_RING_HEAD_OPACITY`, one turn per
      `STATUS_RING_PERIOD_MS`. `native-contract.test.ts` pins those numbers to `geometry.ts`.
      Colour: the vector's white fill is only a mask; `index.android.tsx` passes the theme's
      running colour (`getStatusDotColor` → `theme.colors.statusDotRunning`) as the native
      `color` prop through `withUnistyles`, and the view tints with it, so a theme change
      re-tints the ring without re-rendering its row.
    - **Same phase.** Every Android ring follows one 900 ms clock on `SystemClock.uptimeMillis`.
      A drawable animation cannot start mid-turn, so a ring that appears waits for the next
      quarter boundary (at most 225 ms) drawn turned by whole quarters, which moves the cached
      bitmap exactly instead of resampling it.
    - **Same gating as delta 87.** JS sets `spinning` only while the retained panel is active and
      reduce motion is off; the view also stops (and resets to rest) when it, an ancestor or the
      window is hidden, and when it detaches.
    - **Frame rate.** The view asks for 60 fps (`requestedFrameRate`, API 35+), but the Fold 7's
      display has no adaptive-refresh support (`hasArrSupport false`), so the ring draws at the
      window's 120 Hz there. The owner accepted 120 Hz; moving the ring to its own surface
      (`SurfaceView`, which keeps its own rate) was not taken.
    - **Measured 2026-11-09 on the Fold 7** (profileable build of `c774e5b68`, same scripts and
      screens as delta 87; CPU-s per minute, minute 1 / minute 2; 0.5.100 in brackets):
      finished conversation 33.6/32.3 (44.8/45.1), main thread 2.4 (14.9), RenderThread 28.7,
      14,594 frames in 2 minutes, jank 0; agent running quietly 42.8/42.8 (52.2/49.1); streaming
      80.8/87.6 (70.3/78.4; unchanged code path, run variance); streaming with reduce motion
      32.4 and 1.1 once the reply ended (rings still). Display render rate 120 Hz in 20 of 20
      samples idle and 12 of 12 while flinging the chat. Pixel compare against 0.5.100 at rest
      (reduce motion, three rings, 56×56 px crops): 29 of 3,136 px differ by more than 4/255,
      8 by more than 32/255, at most 65/255, all at the arc's two ends. Background: 15 s on the
      home screen, main thread and RenderThread 0. The plan's targets (15, 20, 40) were not
      reached; at rest the screen costs 1.1, so S1 is almost entirely the 120 Hz ring drawing.
    - **Found, not Daseo's:** with an agent running, 60–65% of the main thread was
      `AccessibilityInteractionController` → `findLabelForView`, driven by two third-party
      accessibility services on the owner's phone (a timer's lock service and the Minimalist
      launcher) rebuilding Daseo's accessibility tree on every content change.
    - **Tried and dropped: one container for the finished history rows.** Streaming's
      remaining cost is each live-head commit cloning, diffing and laying out every mounted
      history row (`ShadowTree::commit` 37%, `cloneChildInPlace` 16% of the JS thread). Markdown
      splitting already touches only the live block (`promoteCompletedAssistantBlocks` in
      `types/stream.ts`). Wrapping the mounted rows in one view needs a regrouping scroll
      component, re-sent cell offsets on every live-head height change, and a replacement for
      Android `maintainVisibleContentPosition`: `MaintainVisibleScrollPositionHelper` anchors on
      the content view's direct children, so one group child shifts the reader on every block
      promotion, and anchoring the footer breaks older-history paging and spacer changes. React
      Native Android ships as the prebuilt `react-android` AAR here, so the helper cannot be
      patched. Dropped as too fragile; mounting fewer history rows was not chosen.
    - **Key files:** `packages/app/modules/daseo-status-ring/`,
      `packages/app/src/components/status-ring/index.android.tsx`, test
      `native-contract.test.ts`.

89. **A terminal tool on Ubuntu aubergine, starting at the left** — the owner's call on
    2026-11-09 after seeing delta 55 in use ("여전히 codex같고 개발자스럽지가 않아 … 이정도는 나도
    하겠는데 느낌") and picking structure B on Ubuntu purple from the preview
    (`~/paseo-builds/preview/daseo-terminal-look.html`: "ubuntu 보라 테마 좋고. 대화가 왼쪽에서
    시작하는 것 좋고."). The research's finding: a colour change only alters the far-away
    impression; up close the app still read as a chat app because of its structure (a centred
    820 px column, icon rows under every answer, pill buttons under the input).
    - **Palette.** The Daseo theme is Ubuntu's terminal: chat `#300A24`, sidebar, tab bar and
      status line `#26071C`, text `#EEEEEC`, one accent `#8AE234` (also `statusDotRunning`, which
      the native Android ring reads), destructive `#F55555`, faintest captions `#9C8094`, Tango
      terminal colours. Only token values changed; no token was renamed or removed. Syntax
      colours that fall under 4.5:1 on the code background are lifted toward white for this
      theme only (`styles/syntax-contrast.ts`). Measured on the chat `#300A24` / code `#3C1430`
      / sidebar `#26071C`: text 15.1 / 13.5 / 16.0, muted 6.8 / 6.1 / 7.2, faintest captions
      5.0 / 4.4 / 5.3, accent 10.9 / 9.8 / 11.5, destructive 5.3 / 4.7 / 5.6, accent text on
      accent 12.0 (the first values, Tango's red `#EF2929` and a caption grey `#86677B`, fell
      under 4.5 and were raised). Delta 55's palette lives on as the **Tokyo Night**
      theme option (same terminal chrome). Pre-paint literals (web `index.html` and manifest,
      Expo splash, Electron window and title-bar overlay, Android block cursor) take the new
      values; they cannot follow a runtime theme choice.
    - **Left-anchored transcript.** On desktop the transcript, task list, subagent track,
      archived callout and composer start at one left inset instead of a centred column.
      Paragraphs, lists, headings and quotes stop at 104 cells of the chat font
      (`proseMeasureWidth`, follows the font size and delta 71's `chatTextScale`); tables,
      code, diffs and tool rows use the pane width. The height estimators measure with the
      same widths so the virtualised list does not jump. The chat outline rail narrows to sit
      in the left gutter. Phones are unchanged.
    - **Words instead of icons.** Message actions read `copy`, `fork`, `undo` on the metadata
      line (always visible, delta 32). Under the input sits one hint line: `model … ▾`,
      `effort … ▾`, `mode … ▾`, then only key hints that really work on that platform
      (`⏎ send`, `⇧⏎ newline`, `⌘L focus`, `/ commands`, `@ files`), `attach`, `dictate`,
      `voice`, then a trailing group that never wraps: the context meter, and on desktop
      `↓ bottom`. Jump-to-newest is that word on desktop instead of a button floating over the
      transcript (it covered the end of wide code blocks and tables): same condition and
      handler, carried from the stream view to the composer by a per-pane bridge
      (`composer/jump-to-bottom.tsx`); the word keeps its space while hidden, so scrolling
      never rewraps the line or moves the composer. Phones keep the floating button. `send` is
      in the accent when there is something to send and muted when disabled; it appears under
      the same rule as the old arrow (content to send, or empty submit allowed; `interrupt`
      while the agent runs). Phones drop the key hints and put send or interrupt in the
      trailing group, so the other words wrap before it, every control with a 44 dp target
      (send's slop is wider for its four-cell word). Tool rows read `✓ read  path … 3s` (`✗` failed,
      delta 73's blinking block while running), the collapsed work row `▸ worked 6m 12s · …`.
      The sidebar loses its decorative icons and letter boxes (`── workspaces ──`, `~/name`,
      a bare status glyph keeps the old overlay's status), and its footer is words. The status
      line starts with the host as an inverse accent block, separates segments with `│`, and
      ends in a clock that re-renders once a minute. Command words stay English in every
      locale, like key names; accessibility labels stay translated.
    - **Not taken from the mock:** the faint band behind sent prompts (it reads like Codex CLI),
      single-letter key labels in front of sidebar rows and actions (`n New workspace`,
      `c copy`: the keys are not bound, so they would be costume), and a markdown restyle.
    - **Key files:** `packages/app/src/styles/theme.ts`, `styles/syntax-contrast.ts`,
      `constants/layout.ts`, `composer/hint-line.tsx`, `composer/jump-to-bottom.tsx`,
      `components/stream-action-label.tsx`,
      `components/message.tsx` (tool rows), `components/sidebar/sidebar-section-rule.tsx`,
      `screens/workspace/workspace-status-line.tsx`.

90. **The phone's browser view holds its picture, and every path an agent names opens or says
    why not** — the owner's report on 2026-11-10 ("폰에서 브라우저 보면 깜빡임이 심함", "링크가
    안 열리는 경우가 많음", "압축 경로").
    - **Stream surface.** The native viewer drew each JPEG frame through React Native's
      `Image`; on Android a new non-resource source fades in for 300 ms
      (`REMOTE_IMAGE_FADE_DURATION_MS`) and the old bitmap is dropped while the next decodes, so
      a 10 fps stream flashed. Frames now go to expo-image (`transition={0}`,
      `cachePolicy="none"`, one `recyclingKey` per browser target), whose two stacked views keep
      the shown bitmap until the next one is decoded. The surface is its own memoized component
      fed by a frame store, so the toolbar, gestures, and keyboard no longer re-render per frame.
      The watch lifecycle is a pure controller (`remote-stream-watch.ts`): a frame that arrives
      before the watch response no longer leaves the 8 s first-frame timer armed (a static page
      went to "retrying" and was unwatched and rewatched), and a real recovery restores the full
      retry budget.
    - **Path resolve.** `fs.path.resolve.request` (gated on `server_info.features.pathResolve`)
      stats the paths a link may mean and, when none exists, walks the workspace or home
      breadth-first for entries ending with the named suffix. It looks inside hidden folders
      (`~/.pi` plans, which the explorer's gitignore-aware suffix search skips) but not package
      stores, VCS internals, `Library`, or the daemon's own `timelines` (2.5 million files on
      this Mac), stops after two matches or 3 s, and confines candidates, roots, and matches to
      the explorer's readable roots (workspace, home, temp). The app sends every local link
      through it before opening: one match opens (Finder or a macOS app on the Mac, delta 56/62;
      the pane or an Android app on the phone, delta 75), several matches, none, or an
      unfinished search give a toast. Nothing opens a pane for a path that does not exist, and
      nothing opens a guess.
    - **Shapes the app now accepts** (`assistant-file-links/parse.ts`, `resolver.ts`): a path
      shortened with `…` or `...` is a search below what the agent kept before the ellipsis
      (`~/.pi/…/x.md`) or below the workspace and home (`…/research/x.md`), never a file; globs
      and brace lists stay text. A bare web address (`invite.folnua.com/seoulforest/`,
      `mac.tail29eaf5.ts.net`) opens over https, and linkify's `http://` in front of a bare host
      becomes `https://` (Tailscale serve answers only https); a file name or a version is never
      a host. Builds, installers, fonts, and more media (`apk`, `aab`, `dmg`, `ipa`, `mkv`, …)
      count as file names, and a bare name with spaces in inline code (`회사 자료 접근 지도.md`)
      resolves unless it starts with a command (`open report.pdf`). Markdown destinations are
      percent-decoded (markdown-it encodes spaces and Korean even inside `<…>`), so `~/` and
      relative links with such names open; before, only absolute ones did.
    - **Corpus** (4,311 turn-final assistant messages, 2026-10-20..11-10, 11,020 links and path
      spans; existence resolved on every 8th message, 1,360 spans, against the disk on
      2026-11-10). Before: 544 opened an existing file (52 of them the first of several
      matches), 426 opened a pane for a missing path, 257 gave a toast. After: 662 open, 103 say
      "several match" (44 of them were the old first-of-several guesses), 466 say "not found",
      0 open a missing-path pane. Shortened paths (all 78): before, 61 opened a missing-path
      pane and none opened a file; after, 39 open the one match, 1 is ambiguous, 17 are not
      found, 21 stay text (globs, brace lists, web paths). The spaced-name rule was narrowed to
      document and media extensions after this run showed it linking commands
      (`vitest kits.test.ts`).
    - **Key files:** `packages/server/src/server/file-explorer/path-resolve.ts`,
      `packages/server/src/server/session/files/workspace-files-session.ts`,
      `packages/app/src/assistant-file-links/{parse,resolver,use-file-link,provider}.ts(x)`,
      `packages/app/src/desktop/browser/pane/{remote-stream-watch.ts,remote-stream-frame.tsx}`.

91. **Browser tools answer, send holds the right edge, and the hint line drops `voice`** — the
    owner on 2026-11-10 ("send가 맨 끝에 있어야 직관적인데 … 중간에 있는 경우가 있어서", "닷새우
    브라우저가 응답을 하지 않는 경우가 있고 … 궁극적으로 개선", "dictate만 남겨주고").
    - **Why tools went silent.** Agents' browser calls timed out 470 times in 30 days (11-04: 62,
      11-05: 79), in episodes of 20–50 minutes that began right after an evaluate and ended by
      themselves; on 11-10 every call, `list_tabs` included, timed out while the desktop app sat
      connected and idle. Each tab's lifecycle steps (wake, throttle, freeze, discard) run on one
      serial chain, and a freeze or wake is a CDP `Page.setWebLifecycleState` with no deadline:
      a page that never answered it held the chain, so every later wake, and every automation
      command behind it (`runAwake`), waited until it settled.
    - **Fix.** A lifecycle step that has not settled after 5 s (`BROWSER_TAB_STEP_TIMEOUT_MS`) is
      logged and the chain moves on; an unanswered freeze is recorded as frozen so the next wake
      re-sends `active`. The renderer handler answers `list_tabs` and `resize` exactly once even
      when they throw. The broker's multi-host `list_tabs` returns the tabs of the hosts that
      answered and fails only when all of them failed.
    - **Send.** `send` (with its `⏎` keycap where Enter submits) is the last word of the hint
      line's trailing group on every platform; on desktop it used to sit after `mode`, mid-line,
      and moved whenever the other words wrapped.
    - **Voice.** The realtime `voice` word is hidden (`SHOW_REALTIME_VOICE_WORD`); `dictate` stays.
      The realtime voice code and its shortcut are untouched.
    - **Key files:** `packages/desktop/src/features/browser-webviews/lifecycle.ts`,
      `packages/app/src/desktop/browser/automation/handler.ts`,
      `packages/server/src/server/browser-tools/broker.ts`,
      `packages/app/src/composer/input/input.tsx`, `packages/app/src/composer/index.tsx`.

92. **No macOS keychain prompt from Daseo, and a stalled browser is named instead of waited
    on** — the owner approved on 2026-11-11 ("권장대로 모두 진행", and for the keychain "어떤 상황에서도
    여기 맥에서 비번 요구 안하게"). Wave 1 was built as 0.5.106 and wave 2 as 0.5.107 (neither activated); both ship in 0.5.108.
    - **Why every browser tool went silent after 0.5.105.** The first tab install after the swap
      loaded the stored passkey with `safeStorage.decryptString`, which reads the keychain on the
      main thread. macOS showed a keychain prompt (SecurityAgent), and `sample` showed the main
      thread inside `SecItemCopyMatching` for 85+ minutes: every command that needs the main
      process timed out at 15 s, `main.log` stopped, and only renderer-side calls answered. The
      app is signed without a Team ID, so the keychain trusted each build separately; the unified
      log shows a prompt at every swap since the first passkey was stored (11-09).
    - **Passkey keys never touch the keychain.** Private keys are sealed with AES-256-GCM
      (`node:crypto`) under an app key that lives in 1Password (`Daseo — PERSONAL_DASEO_PASSKEY_KEY`,
      vault 개인 로그인) and reaches the main process through `~/.config/agent-secrets/common.env`,
      which the login-shell environment brings in at startup. Without the key, or with a store sealed
      under another key, passkeys are off for that run and `browser_passkeys` says why; there is no
      keychain fallback. The keychain-sealed store from before (one unused accounts.meta.com
      passkey) is dropped once, with one log line, without reading it. The daemon's Claude quota
      card no longer falls back to the keychain copy of Claude Code's login (it ran the `security`
      tool); without `~/.claude/.credentials.json` the card says Unavailable. A test
      (`packages/desktop/src/no-keychain.test.ts`) fails if desktop, server, or CLI source uses
      `safeStorage`, `keytar`, the keychain C API, or the keychain command-line tool;
      `EnableCookieEncryption` is off in the built app (`@electron/fuses read`). Wave 1's async
      `safeStorage` store (worker-thread keychain read) is gone with it.
    - **A stalled app is named.** While a browser request is unanswered, the desktop renderer
      pings the main process every 5 s (`paseo:browser:ping`); a ping without a reply in 2 s
      answers the request with `browser_timeout`, `hostUnresponsive: true` (an optional error
      field) and a message that names the main process and the usual cause. A slow command
      whose main process keeps answering is not cut short. The daemon runs
      `pgrep -x SecurityAgent` (cached 3 s) on that failure and on its own 15 s timeout, adds "a
      macOS security prompt is open on the Mac" to the message, and sends one push per stall episode
      ("Mac의 Daseo가 macOS 확인 창 때문에 멈췄습니다…"): not again until a browser command is
      answered, or 30 minutes passed.
    - **A DevTools command that never answers frees the tab.** Each slot of a tab's CDP queue has a
      deadline (10 s; full-page capture 35 s). A slot past it is released, its caller gets a
      retryable `browser_timeout` naming the CDP method, and the late result is dropped. Page
      dialogs are answered outside the queue (delta 93).
    - **A still-loading page answers.** `webContents.executeJavaScript` waits until the page stops
      loading; page scripts now run through `mainFrame.executeJavaScript`, which does not (measured
      with Electron 44.10.2: 3 ms against no answer in 3 s on a page holding one image open). It
      needs an explicit boolean `userGesture`. Snapshot, read, and evaluate results from a page
      still loading carry `loading: true` and a one-line note.
    - **Busy and crashed tabs.** Electron's `unresponsive` never fired for a busy-looping agent tab
      (no event in 25 s, window shown, a mouse event sent), so the page is checked directly.
      Before every tab command, after the wake (a frozen page runs no script), one trivial
      main-frame script must answer within 3 s; a page script still unanswered after 3 s gets
      another check of 1.5 s. A busy page fails with "not responding; try browser_reload or close
      the tab" in about 3 s (harness) instead of a 15 s timeout; reload, navigate, back, forward,
      and close always run. A page waiting on its own dialog is not busy (delta 93): neither check
      runs on it. `render-process-gone` marks a crash until the page
      loads again; the memory-pressure discard is not a crash. Nothing kills a renderer.
    - **Downloads.** A download a tab starts within a minute of an agent's command on it (or on the
      tab that opened its popup) is saved without a dialog to `~/Downloads/Daseo/<unique name>`;
      downloads a person starts keep the save dialog. `browser_wait download` returns the tab's
      oldest unreturned download, or the next one, once it is done, with its path.
    - **Tab events.** A popup or new tab a page opened, a popup that closed by itself, and
      download start, finish, or failure are queued per tab and handed out once (`events`, plus
      one line each) with the next result for that tab or for the agent that last used it. A
      root tab the user closes is not reported: the agent's next command on it says not found.
    - **Dialogs during navigation**: an `alert()` while a navigate, reload, back, or forward loads
      is answered at once and reported (unit test and capture harness `delta92`); since delta 93
      the page-dialog owner does it.
    - **Readable evaluate values.** `undefined`, `NaN`, `Infinity`, BigInt, circular objects, DOM
      nodes, Map, Set, errors, and regexes come back as readable tokens; a value JSON can hold is
      still exactly what `JSON.stringify` writes.
    - **main.log.** Browser lifecycle and automation warnings in the main process went to
      `console`, which electron-log never writes to `main.log`; they use electron-log now.
    - **Key files:** `packages/desktop/src/features/browser-automation/{passkeys,ipc,cdp-session-queue,renderer-health,downloads,tab-events,evaluate-serialize}.ts`,
      `packages/desktop/src/features/browser-webviews/index.ts`, `packages/desktop/src/main.ts`,
      `packages/desktop/src/preload.ts`, `packages/app/src/desktop/browser/automation/handler.ts`,
      `packages/server/src/server/browser-tools/{broker,host-stall,tools}.ts`,
      `packages/protocol/src/browser-automation/rpc-schemas.ts`; capture harness group `delta92`.

93. **Page dialogs stay in their tab, and the agent answers them** — the owner's report on
    2026-11-11 (page pop-ups and alert windows were not recognised or confirmed by agents and
    appeared over whatever session he was in, worst on Cafe24 admin); plan approved the same day.
    - **Why.** Electron 44 answers `alert` and `confirm` in a JS listener on the internal
      per-WebContents event `-run-dialog` (`lib/browser/api/web-contents.ts`), which calls
      `dialog.showMessageBox` parented to the owner window: a macOS sheet over the whole Daseo
      window. The old per-tab DevTools monitor answered only while a command ran (and always for
      popups), with a fixed policy that dismissed every confirm, so agents overrode
      `window.confirm` by hand. `prompt()` never reached anyone: Electron's renderer replaces
      `window.prompt` with a function that throws (`lib/renderer/window-setup.ts`).
    - **One owner per tab, no native box.** For every browser-profile WebContents
      (`web-contents-created` on the profile session, plus every adapted tab and popup) the
      default `-run-dialog` listener is replaced with Daseo's (`page-dialog-hook.ts`), and
      `-cancel-dialogs` closes a held dialog. `-run-dialog` is internal (electron/electron#26160 is
      still open): a missing listener logs an error, and `webPreferences.disableDialogs`, set on
      every browser webview and popup, keeps Electron's own listener from showing a box; capture
      harness group `dialogs` fails if either breaks. The DevTools dialog monitor and the prompt
      recorder are gone.
    - **Prompt works.** A document-start DevTools script (`Page.addScriptToEvaluateOnNewDocument`,
      `runImmediately`) puts Chromium's own `prompt` back, taken from a short-lived about:blank
      frame and called on the page's window, so `prompt()` reaches the owner as type `prompt` and
      an accepted answer returns its text (measured: head script, srcdoc frame, later call).
      Cross-origin out-of-process frames keep Electron's throwing `prompt`.
    - **Policy** (`page-dialogs.ts`). Alert: accepted at once when an agent is involved (a command
      runs, or an agent used the tab in the last 60 s) and reported. Confirm and prompt: answered
      at once only with the new `dialog: "accept" | "dismiss"` (and `promptText`) argument on
      `browser_click`, `browser_keypress`, and `browser_evaluate`; otherwise held. A held dialog
      ends the command that raised it at once with `openDialog` (an action command keeps its
      result; evaluate, wait, and the readers say they have none), tools that need the page
      answer `browser_denied` with `openDialog` at once instead of timing out, and navigate,
      back, forward, reload, and close still run: a held dialog blocks Chromium's navigation
      (`loadURL` waited 8 s and more), so an agent's navigation dismisses it first. The new
      `browser_handle_dialog` (`accept`, `promptText`) answers it and reports the dialogs the
      page shows next. Nobody answers within 60 s: dismissed, reported on the tab's next result
      (`reason: "unanswered"`). No agent involved: the dialog waits in the tab's pane for the
      person, with no deadline; an agent command on that tab accepts an alert left there and
      starts the 60 s deadline for a confirm or prompt. No pane can show it (an old renderer):
      alert accepted, confirm and prompt dismissed, recorded. A tab waiting on a dialog is neither
      frozen nor discarded, and renderer health does not call it busy.
    - **In the pane.** Main sends `browser-page-dialog` events to the host window that called
      `watchPageDialogs`; the pane shows a card (site, message, a text field for prompt, OK and
      Cancel) portaled into the tab's resident browser surface, which is parked 1x1 whenever the
      tab is not presented, so another tab, workspace, or the phone shows nothing and nothing is
      blocked. A popup's dialog shows in the pane while its native view steps aside. The card
      takes focus only when focus was already in that pane's page or nowhere (delta 14); Enter
      answers OK, Escape Cancel; focus returns to the page. The tab's strip icon shows the
      existing needs-input mark while a dialog waits. First answer wins between the pane and an
      agent; a person answering a dialog an agent waited on is reported (`reason: "person"`).
    - **beforeunload.** `will-prevent-unload` is always let through: an agent's navigation is
      reported as `accepted beforeunload`, and a person's navigation or tab close leaves the page
      too (Electron decides synchronously, so an in-tab question cannot be asked; before, the page
      silently stayed and could not be left).
    - **Notifications.** The browser profile session gets permission request and check handlers
      that deny `notifications` and keep Electron's defaults for everything else (grant all
      requests; checks pass except `deprecated-sync-clipboard-read`): `Notification.permission`
      reads `denied` (harness), passkeys and clipboard-write unchanged.
    - **Protocol.** New command `handle_dialog`, gated through `browserHost.supportedCommands`; the
      broker refuses a `dialog` argument for a host that lacks `handle_dialog`, since an older
      desktop's strict args would reject the whole command. Optional `openDialog` on both
      execute.response branches and optional `reason` and `url` on dialog events; the
      `Handled browser dialog…` line keeps its shape.
    - **Key files:** `packages/desktop/src/features/browser-automation/{page-dialogs,page-dialog-hook,service,ipc,renderer-health}.ts`,
      `packages/desktop/src/features/browser-profile.ts`, `packages/desktop/src/main.ts`,
      `packages/desktop/src/preload.ts`, `packages/app/src/desktop/browser/{page-dialogs.ts,panel.tsx}`,
      `packages/app/src/desktop/browser/pane/{index,page-dialog-card}.electron.tsx`,
      `packages/server/src/server/browser-tools/{broker,tools}.ts`,
      `packages/protocol/src/browser-automation/rpc-schemas.ts`; capture harness group `dialogs`,
      `packages/desktop/e2e/browser-tabs.e2e.mjs` (pane-only card, composer focus in another
      workspace).

94. **A fourth passkey can be registered** — measured 2026-11-11 on Electron 44.10.2: Chromium's
    virtual authenticator answers a site's `create()` with `CTAP2_ERR_KEY_STORE_FULL` once it holds
    three discoverable credentials, and the page sees `NotAllowedError` within milliseconds. Delta 78
    loaded every stored passkey into every tab as discoverable, so with three passkeys stored
    (github.com and two google.com accounts) every further registration failed on every site
    (first seen on `auth.openai.com`, reproduced on webauthn.io). Credentials loaded as
    non-discoverable do not count (20 loaded, `create()` succeeded) and still sign in when the
    site names them in `allowCredentials`. A tab now loads at most two discoverable credentials,
    the most recently used ones of its own site (`planTabCredentials`, `DISCOVERABLE_SLOTS`);
    every other stored passkey is loaded non-discoverable, a registration that fills the third
    slot reloads the tab's authenticator, and a credential synced from another tab takes a
    discoverable slot only on its own site while one is free. Limit: a site with three or more
    stored accounts offers only the two latest used in a username-less prompt; the others sign in
    after the site asks for the account first. Key files:
    `packages/desktop/src/features/browser-automation/passkeys.ts`, `passkeys.test.ts`.

95. **A Pi session's task list is the board above the composer** — the owner's ask on
    2026-11-13: inside one long session he loses track of the items a research turn proposed (69
    "what is left?" questions in 46 sessions from 2026-10-14 to 11-13). Claude Code and Codex
    already fed delta 57's task line; Pi sessions only showed `todo` tool rows.
    - **Source.** The list is rpiv-todo's own, one per session. Its `todo` tool (also accepted as
      `mcp__custom-tools__todo`) returns the whole list after every call in `details.tasks`; the
      Pi provider turns each successful mutating call into the provider `todo` item, live and in
      history replay. A failed call, `list` and `get`, and an unchanged list add nothing; the tool
      row stays as before.
    - **States.** A pending task with `metadata.state` `hold` or `decision` is held or waits for
      the owner; `metadata.note` is its one-line reason on any task; a deleted task is kept with
      its note. On the wire these are optional `state` (`hold | decision | deleted`) and `note`;
      `status` stays three-valued (a dropped task travels as `pending`), so an app from before
      parses every item and shows held, waiting, and dropped tasks as plain pending. Any other
      `metadata.state` reads as pending.
    - **Board.** The collapsed line reads done/total with dropped tasks left out, then the
      waiting and held counts when non-zero, then `Now: <activeForm>` or the next plain pending
      task (`작업 3/9개 · 결정 대기 2 · 보류 2 · 지금: …`). Expanded, tasks keep the agent's
      order, so "items 1 and 3" still match; each row has a state icon (a decision uses the
      warning color of an agent that needs the owner) and a muted `state: note` suffix; dropped
      tasks sit dimmed in their own collapsed group. The list scrolls inside 30% of the height
      left above the keyboard (at least 120 dp), which with delta 59's input cap keeps the
      prompt below the header on the Fold 7 inner screen. Claude Code and Codex lines change only
      by the `Now:` word on a task in progress.
      Since delta 101 this board shows only in desktop focus mode; everywhere else the right
      panel shows the tasks grouped by state.
    - **Reopening.** The board used to be derived from the loaded timeline page alone (40 rows),
      so a chat whose last task update was older than the page lost its board on reopen, and a
      page without a `todo` row deleted it, for every provider. Tail and after pages now carry
      `tasks`, the newest list at or before the page end; the app takes live rows first, then
      that list, then the page. A before page never moves the list.
    - **Key files:** `packages/server/src/server/agent/providers/pi/todo-mapper.ts`,
      `providers/pi/{agent,history-mapper}.ts`, `agent/agent-timeline-store.ts`
      (`getLatestTasks`), `session.ts` (`readTimelinePageTasks`),
      `packages/protocol/src/{agent-types,messages}.ts` (`AgentTaskItemPayloadSchema`),
      `packages/app/src/composer/task-list/{index,summary,list-height}.ts{,x}`,
      `components/task-list-row.tsx`, `stores/session-store.ts` (`resolveTimelinePageTasks`).

96. **A sent prompt stays sent on Android** — the owner's report on 2026-11-13 ("엄청 긴
    프롬프트를 보낼 때 보내지긴 하는데 입력창에 그대로 프롬프트가 남아 있고, 갑자기 입력창이
    높아지는 버그"). Delta 18 guards a native replacement: Fabric drops a replace command whose
    event count is stale, and the IME event that made it stale arrives afterwards carrying the
    text from before, so the composer pushes the replacement out again instead of taking that
    text as typing. Sending clears through that replacement, and the draft echoes every
    replacement back through `textReplacementKey`; the input then applied the same empty text a
    second time, and that reset the guard. When the IME still held text when send was pressed (a
    voice-typed phrase not yet committed, which long dictated prompts end with), its late commit
    was accepted as new input: the whole prompt came back into the field and the draft, and the
    field grew back to full height. Re-applying the text a replacement is already waiting for
    now keeps that replacement's guard (the command is still sent again). Only native inputs get
    the guard: the web input writes the DOM value at once, and a guard there would only reject
    pasting the text just sent. On web, measured 2026-11-13 on the dev app with 4,465 and 7,749
    Korean characters, sending idle, steering a running agent, and sampling 90 frames after
    Enter all left an empty 46 px input; the bug did not reproduce there. Key files:
    `packages/app/src/components/ui/text-input/native-replacement.ts`,
    `packages/app/src/composer/input/input.tsx` (`replaceNativeText`).

97. **Tabs unused for three hours give their memory back without memory pressure** — the
    2026-11-13 RAM plan: delta 43 discards only while macOS reports memory pressure, and this Mac
    held 10 renderers 16 hours old (about 2.8 GB) that no warning ever reached, with nothing in
    the log saying why each one stayed.
    - **Idle discard.** Every 30 s check without memory pressure discards at most one tab frozen
      and unused for `browser.discardIdleTabsAfterMinutes` (desktop settings file, default 180,
      0 turns it off; no UI). Chrome's Memory Saver and Edge's sleeping tabs go at two hours. It
      uses delta 43's candidate list and blockers unchanged, oldest first; under pressure the
      pressure rules apply, and a shorter idle setting is never lengthened by them.
    - **Why a tab stays.** The blocker check returns a reason (`edited`, `downloading`,
      `freeze-exempt`, `destroyed`, `no-pid`, `shared-renderer`); a candidate kept for one is
      logged as `[browser-lifecycle] discard skipped {browserId, reason, idleMinutes}` at most
      once an hour per tab. Each discard logs its idle minutes with `discarded after idle` or
      `discarded under memory pressure`.
    - **Tab report.** `browser_tab_report` (new `tab_report` command, gated on
      `browserHost.supportedCommands`) lists every resident tab on the Mac with its lifecycle
      state, held or not, minutes idle, renderer pid, `footprint` memory, and what would keep its
      page (`popup` for popups). Read-only: it wakes, holds, and marks nothing. Tabs never shown
      since launch have no guest and are not listed.
    - **Waking a discarded tab.** The wake reloaded and waited up to 30 s for the load to stop,
      but the lifecycle step gave up after 5 s, so the first command could meet a page mid-load.
      The reload now resolves at `dom-ready` (or a stopped load), with one 10 s budget for both
      reload attempts, and a step that starts on a discarded tab gets 11 s instead of 5. The
      daemon gives each browser tool 15 s, so a page slower than 10 s falls through with a live
      renderer, as a slow page did before, and the command keeps about 4 s. `hold`
      and `runAwake` both wake; concurrent wakes with nothing queued between them now share one
      step, so a reload that runs out of time is not started again at once by the same command's
      second wake (that command would have waited 22 s).
    - **Checks.** Unit tests in `discard.test.ts`, `lifecycle.test.ts`, and `restore.test.ts`;
      capture harness group `tab-discard` (an agent-typed tab and a tab shown in a pane are kept,
      the untouched one is discarded and its renderer ends, and `browser_snapshot` reloads it in
      about 0.4 s with the page parsed). `PASEO_BROWSER_TAB_LIFECYCLE_MS` takes an optional third
      value, the idle discard time.
    - **Key files:** `packages/desktop/src/features/browser-webviews/{discard,lifecycle,restore,renderer-footprint,index}.ts`,
      `packages/desktop/src/settings/desktop-settings.ts`, `packages/desktop/src/main.ts`,
      `packages/desktop/src/features/browser-automation/{service,ipc}.ts`,
      `packages/protocol/src/browser-automation/rpc-schemas.ts`,
      `packages/server/src/server/browser-tools/tools.ts`.

98. **Tabs an agent opened and nobody looked at close when the agent is done** — the
    2026-11-13 RAM plan: over 14 days agents opened 1,933 tabs and closed 940, and tab records
    said neither who opened a tab nor when it was last used, so a finished job's tabs could not be
    told from a person's.
    - **Provenance.** A new per-client store, `workspace-browser-provenance`, records for each tab
      who opened it (`agent` with the creator's id, or `human`), when an agent last sent it a
      command and which agent, and whether a person has ever had it on screen or used it. It is
      kept apart from the browser records on purpose: those are validated strictly and an older
      build deletes the whole store on an unknown field, which would lose every tab's URL on a
      rollback; an older build simply ignores the new store. Agent tool calls carry an agent id;
      the phone's remote open, stream, and stream input reach the desktop without one and count as
      a person. A pane presenting a tab marks it seen. Tabs with no record (opened before this
      build, by a person in the app, or adopted) have unknown origin and are never closed.
    - **Rule.** Every 10 minutes (first sweep 2 minutes after connecting) the desktop app looks at
      this daemon's workspaces and closes a tab only when an agent opened it, no person ever saw
      or used it, it is not the selected tab of any pane, no other agent used it within the idle
      time, and either its creator is archived and last used the tab at least 6 hours ago
      (`ARCHIVED_CREATOR_GRACE_MS`; the idle setting caps it when shorter), or its creator has
      sent no browser command for `browser.autoCloseAgentTabsAfterHours` (24) and is not running
      or holding background waits. The grace exists because an implementer often leaves a page
      open for the owner and is archived by its lead minutes later, before he has looked. The
      creator's state comes from the daemon (`fetch_agent` reads archived records too); a creator
      the daemon cannot be asked about keeps the tab. Main then vetoes any tab a pane shows, a
      command, capture, or phone stream holds, that was typed into, is downloading, capturing
      network, holding a dialog, playing sound, or has a popup open. Each close is re-checked
      against the stores and main right before it happens.
    - **Rehearsal.** `browser.autoCloseAgentTabs` is `rehearse` by default: main logs a
      `[browser-auto-close] would close` line (browser id, workspace id, reason, creator agent id,
      idle hours, host) once a day per tab and nothing closes. `on` closes and logs `closed`;
      `off` does neither. File-only; no UI.
    - **Recently closed.** A closed tab goes to its workspace's list (URL, title, time, reason) for
      14 days, at most 50. The tab row's ∨ menu shows the newest ten under "Recently closed tabs"
      only when the list is not empty; choosing one reopens it focused at its URL as a person's
      tab. In rehearsal the list stays empty, so nothing in the UI changes.
    - **Agents.** `browser_new_tab` asks the agent to close the tabs it opened when its task is
      done, unless the user should see them. `browser_list_tabs` ends with one line when more than
      three listed tabs are the calling agent's and unseen (optional `unseenOpenedByAgent` on the
      result; an older daemon strips it). The plan's "when the agent ends its turn" is approximated
      by every list call: the app has no turn-end signal.
    - **Checks.** Unit tests in `provenance/{auto-close,sweeper}.test.ts`, `handler.test.ts`,
      `desktop-settings.test.ts`, `browser-webviews/auto-close.test.ts`; the desktop browser E2E's
      auto-close regression (an agent opens two tabs, a person shows one, the agent is archived:
      only the other closes, appears under recently closed, and reopens at its URL), run with
      `autoCloseAgentTabs: "on"` and `PASEO_BROWSER_AUTO_CLOSE_SWEEP_MS="3000,10000"` (a test
      seam main passes to the app: a 3 s sweep and a 10 s archived-creator grace; the run checks
      the tab is still open one sweep after the archive).
    - **Key files:** `packages/app/src/desktop/browser/provenance/{state,index,auto-close,sweeper,reopen}.ts`,
      `packages/app/src/desktop/browser/automation/handler.ts`, `resident-webviews.ts`,
      `packages/app/src/screens/workspace/workspace-desktop-tabs-row.tsx`,
      `packages/desktop/src/features/browser-webviews/{index,auto-close}.ts`,
      `packages/desktop/src/{main,preload}.ts`, `packages/desktop/src/settings/desktop-settings.ts`,
      `packages/protocol/src/browser-automation/rpc-schemas.ts`,
      `packages/server/src/server/browser-tools/tools.ts`.

99. **`browser_network` exports a sanitized HAR** — the 2026-11-13 benchmarking plan: agents used
    `browser_network` in 62 sessions in seven weeks (25 starts in the busiest week) to learn other
    products' and vendors' internal APIs, and read every request in chat: 64 KB per body, nothing
    on disk, no response headers, and bodies gone once the page navigated. On a real shop page the
    largest API response was 467 KB.
    - **Export.** `browser_network` `action: "export"` writes the tab's capture as one HAR 1.2
      file and returns its path and a summary (entries, pages, bodies kept or not and why,
      WebSocket frames, what was redacted, top hosts); the capture keeps running. It takes the
      list filters plus `path`, `bodies` (`api` or `none`), `includeWebSocket`, and `overwrite`.
      The desktop main process holds the capture, so it builds and writes the file itself
      (temporary file then rename, mode 0600, an existing file only with `overwrite`, never a
      directory); the HAR never crosses IPC or the daemon socket. The daemon resolves `path` like
      `browser_screenshot`'s `savePath`; without one the file goes to
      `~/Downloads/Daseo/network-<host>-<YYYYMMDD-HHmmss>.har`, on the machine running the desktop
      app. Requests still in flight are counted, not exported; open WebSockets and EventSource
      streams are exported with `_daseo.open`. Requests for `data:`, `blob:`, `about:`, and other
      URLs that never touched the network are left out and counted (`skippedNonNetwork`): a
      `data:` URL can be megabytes inside `request.url`. An empty capture writes nothing.
    - **What the file holds.** Each redirect hop is its own entry; wire request headers (cookies
      included) and response headers come from the ExtraInfo events, joined by request id and hop
      index whichever order they arrive in, and the basic event's headers stand when none comes.
      Timings follow DevTools (TLS inside connect, counted once; skipped phases -1), sizes are -1
      when not known, and `httpVersion` is empty rather than a guessed HTTP/1.1. Pages come from
      main-frame documents (frame id from `Page.getFrameTree` at export; no pages without it).
      DevTools' `_resourceType`, `_initiator`, `_fromCache`, `_transferSize`, `_error`,
      `_webSocketMessages`, and `_eventSourceMessages` are used, and `_daseo` marks a body that is
      cut (`bodyTruncated`) or missing (`bodyUnavailable`: binary, evicted, budget, redirect,
      failed, not-captured). `har-to-openapi` 3.0.1 turns it into an OpenAPI spec, but with
      `--validate` it rejects the whole file for one non-`http(s)` entry (its URL filter runs
      after that check). WebSocket entries keep their `ws(s)://` URL, as DevTools writes them, so
      a conversion uses an `http(s)`-only copy, an export with `includeWebSocket: false`, or no
      `--validate`.
    - **Bodies that survive navigation.** While a capture runs, an XHR, fetch, document, or
      EventSource response, or any other textual one except scripts, stylesheets, images, fonts,
      and media, is copied out with `Network.getResponseBody` the moment it finishes, through the
      tab's CDP queue: 2 MiB per body (the head is kept and the full length recorded), 48 MiB per
      tab (oldest kept bodies dropped first and marked `budget`). Request bodies Chromium leaves
      out of the event are fetched at send time. `list` reads the kept copy too, so a body is no
      longer `evicted` after a navigation; its 64 KB and 256 KB caps are unchanged. WebSocket
      frames: the first and last 100 per socket, 16 K characters each, binary frames by length
      only; EventSource the first and last 250 messages; 4 MiB of both per tab. With no capture
      running none of this runs (the networkidle watcher path is unchanged).
    - **Always sanitized.** There is no raw export. Credential headers (Cookie, Set-Cookie,
      Authorization with its scheme word kept, `x-api-key`, CSRF and session headers, any name with
      token, secret, signature, api-key, or session) keep their names; secret query, form,
      multipart, and JSON fields at any depth in request and response bodies (password and
      one-time-code names, tokens, `client_secret`, `sig`, `session`, `key` of 16+ characters,
      OAuth `code` beside `state` or `redirect_uri`) keep their keys. Each replaced value of 8+
      characters becomes a stable `<redacted-N>` everywhere it occurs in the file, URL-encoded
      too, so "received here, sent there" stays readable; JWTs anywhere become
      `<redacted-jwt-N>`. A test server that echoed a posted password put it in the generated
      OpenAPI before; Chrome's own sanitized export only clears cookies and Authorization.
      Personal data in bodies (names, e-mails) is not removed, and the comment in the file says so.
    - **List.** `includeResponseHeaders` adds each entry's response headers with credentials
      redacted (pagination, rate-limit, content-disposition).
    - **Compatibility.** Export is a new `network_export` command, not a `network` action: the
      action enum is closed and an older host would reject a new value. The broker sends it, and a
      list with `includeResponseHeaders`, only to a host that advertises `network_export`; an
      older app gets `browser_unsupported` naming the update. Ledger entries in
      `packages/protocol/wire-compat-ledger.json`.
    - **Checks.** Unit tests in `network-capture.test.ts`, `network-har.test.ts`,
      `network-har-sanitize.test.ts`, `network-export.test.ts`, `service.test.ts`, `rpc-schemas`
      and tool tests; capture harness `frames-network` exports a real capture across a navigation
      from a fixture with an HttpOnly cookie, a bearer API, a 302, a 404, a password echo, and a
      WebSocket, and checks that none of the secrets is in the file. Measured there: one
      `Network.getResponseBody` per API request and no other extra CDP command, and about 0.75 MB
      of main-process heap held for 150 captured requests with 2 KB bodies.
    - **Key files:** `packages/desktop/src/features/browser-automation/{network-capture,network-har,network-har-sanitize,network-export,service,ipc}.ts`,
      `packages/protocol/src/browser-automation/rpc-schemas.ts`,
      `packages/protocol/src/paseo-tool-call-detail.ts`,
      `packages/server/src/server/browser-tools/{tools,broker}.ts`.

100. **A click says what it caused** — the lead's report on 2026-11-13: `browser_click` on a
     background tab "only moved focus" on the Google account chooser and on Vercel's passkey "Add",
     and agents pressed Enter on top of it. Measured the same day on the live pages: the click
     activated every time (Vercel "Add" 3 of 3, the chooser's form submitted 4 of 4). The Vercel
     dialog's DOM appeared 15 ms after the click, but `browser_find role=dialog` run at once said
     "no match": the modal mounts at opacity 0, waits about 100 ms, and fades in over 300 ms, and
     find and snapshot dropped an opacity-0 element with its whole subtree. The tool answered a bare
     "Clicked" the moment the events were dispatched, so an early look read "nothing happened".
     - **Effect line.** `browser_click`, and `browser_keypress` with Enter or Space on a ref, arm a
       probe in the page before the input (`input-effect.ts`) and return one line in the new
       optional `effect` field, which the tool text appends: a navigation that started (main-frame
       `did-start-navigation`, same-document moves included), a popup, tab, or download (the tab
       event queue now has subscribers), a page dialog (the dialog owner calls opening listeners), a
       dialog or menu that appeared (marked still fading in), an ARIA or form state attribute that
       changed on or within three levels around the element, content or text that changed there or
       was added at the top of the body, a value or checked change, the element removed, a submit
       the page cancelled, or no change. The first effect ends the wait; only an input with no
       effect waits the 500 ms window and then says "no change seen within 500 ms", adding "only
       focus moved to the element" when that is all that happened. A key is armed after the element
       is focused, so the focus move is not counted as its effect. Measured in the harness, clicks
       with an immediate effect took 36-50 ms against 35-38 ms before; a no-op takes about 537 ms.
       An older desktop sends no `effect` and the line stays "Clicked browser element @eN.".
     - **Appearing elements.** The shared ARIA script counts an element at opacity 0 as visible,
       and marks it `appearing=true`, when it runs an animation that ends visible, or when it has a
       transition or animation declared and was inserted within the last second. Insertion times
       come from one childList observer per page, installed by the first snapshot, find, or
       observed input (`INSERTION_LOG_SOURCE`). An element held at opacity 0 with no motion, or
       inserted earlier, stays hidden. Not covered: an overlay shown by a class change rather than
       an insertion is marked only once its transition is running.
     - **Click conformance.** The background click now sends what a real mouse click sends in
       Chromium: `buttons` 1 (2 right, 4 middle) and pressure 0.5 on pointerdown and mousedown, 0 on
       the release and click; focus moves as mousedown's default action to the nearest focusable
       element, and not at all when the page cancels mousedown. It used to focus first and send
       `buttons` 0. Background clicks still reach only the page (delta 14).
     - **Open observation.** In the lead's run on 2026-11-13 10:17-10:25 the first input on a
       freshly opened Google account chooser was lost once for each input kind: on the chooser
       opened from bunny.net a click left the page unchanged for seconds and Enter then navigated;
       on the chooser opened from vercel.com a trusted Enter changed nothing and a click then
       navigated. Not reproduced (the chooser opened from bunny's own OAuth URL submitted on the
       first click 4 of 4); the page has a `data-is-submitted` double-submit guard and a BotGuard
       submit hook. An agent now sees "no change seen" and can retry knowingly.
     - **Checks.** Capture harness group `click-effect` (fade-in dialog, no-op, aria-expanded on
       the background and the trusted path, Enter, slow form post, link, cancelled submit, event
       order): 11 of 11 fail against the committed 0.5.113 build (`PASEO_CAPTURE_HARNESS_DIST_DIR`)
       and pass with this change. In that inactive harness window a trusted key does not reach a
       background guest with either build, so the Enter check requires only an honest result. Unit
       tests in `input-effect.test.ts`, `aria-snapshot-script.test.ts` (appearing, click order, the
       probe in jsdom), `service.test.ts`, `tab-events.test.ts`, `page-dialogs.test.ts`, and the
       server `tools.test.ts`.
     - **Key files:** `packages/desktop/src/features/browser-automation/{input-effect,aria-snapshot-script,focus-isolated-input,service,ipc,page-dialogs,tab-events}.ts`,
       `packages/protocol/src/browser-automation/rpc-schemas.ts`,
       `packages/server/src/server/browser-tools/tools.ts`, `packages/desktop/capture-harness/main.js`.

101. **The task list lives in the right panel** — the owner's ask on 2026-11-13: above the
     composer the subagents track and the task board together were too busy, and he never uses
     the explorer ("explorer는 아예 안써서 그거 그냥 없애고 대신에 tasks list뜨게 … tasks
     처음으로 생기면 자동으로 열리고"; then "그 토글 그거 그대로 갖다 쓰는데 안에 내용만
     달라지는거지"). Later the same day, for the phone ("닫은 좁은 화면 티피컬한 모바일
     스크린에서도 오른쪽 상단 사이드패널 아이콘 있고 이거 누르면 현재는 files뜨는데 이것도 다
     교체해주고 task list로", "모바일에서는 왜 여전히 task list가 입력창 위에 뜨지"): compact
     layouts get the same task list in their right panel.
     - **Sidebar.** Wherever the right sidebar is a pinned panel (desktop app, browser, unfolded
       Fold) and focus mode is off, it keeps its toggle button, icon, `Cmd+E` shortcut, width,
       resize handle, close button, and persisted open state (`desktop.fileExplorerOpen`), and
       holds the viewed tab's task list instead of the Changes, Files, and PR tabs. The toggle no
       longer carries the `+N -M` changes count (it opens the task list, not the changes). The header
       carries only the progress of delta 95's line (`작업 3/9개`), at reading size: the sections
       below show the task in progress and count what waits and what is held. A tab that is not an
       agent session, or a session without a list, shows "No task list yet". Read-only. The toggle
       says "Open/Close/Toggle tasks" in every locale.
     - **Compact panel.** On compact layouts (phone, folded Fold, a narrow browser window) the
       header's right toggle (`PanelRight` icon, never the source-control icon, no count) and the
       swipe in from the right edge open the right overlay (mobile panel target `file-explorer`,
       see `docs/mobile-panels.md`) with the same header and sections. `Cmd+E` does not: every
       keyboard shortcut is off on compact layouts and in the native app
       (`keyboard/availability.ts`), so the workspace screen's handler for it never runs there. The
       overlay is mounted at app level, outside the workspace screen, so it reads the viewed tab
       from the workspace layout store (the focused pane's active tab, the same pure function the
       workspace screen uses: `task-sidebar/viewed-agent.ts`). It needs no workspace directory and
       starts no checkout, file-tree, diff, branch, or PR request. Compact never opens it by itself
       (it would cover the chat), and the terminal's swipe-left stays off.
     - **Sections.** The owner's follow-up the same day ("상태에 따라서 섹션 나눠서 정리되면 …
       기존 순서대로 섞여있으니까 헷갈려서. 그 폰트 크기도 적당히 크게"): the sidebar groups the
       tasks as In progress, Needs your decision, To do, On hold, Done, Dropped, each under the
       left sidebar's `── label · count ──` rule (delta 89); a section with no task is not drawn.
       The decision rule is in the warning status color. Done and Dropped fold like the pinned
       section but always show ▸/▾ (the pinned section shows it on hover), and start folded on
       every mount. Inside a section tasks keep the
       agent's order, so numbered subjects still read in order. A row is the subject at the chat's
       prose size (up to three lines), then what a task in progress is doing now, then the agent's
       note, each on its own smaller muted line (14 on 20, the prose leading of that size) without
       the state word. Claude Code and Codex
       lists show only In progress, To do, and Done. One pure function places the tasks
       (`composer/task-list/sections.ts`, on `resolveTaskRowState`); the board above the composer
       keeps its full line, the agent's flat order, and its one-line rows (`TaskListBody`, the
       row's `board` variant).
     - **Board.** The board above the composer is drawn only in desktop focus mode, which is a
       wide-layout state that compact layouts ignore (`task-sidebar/layout.ts`). The subagents
       track is unchanged.
     - **Auto-open.** When a live stream event gives the viewed session its first task list (it
       had none and its timeline was already synced), the sidebar opens once. Timeline pages,
       reopening a session, switching tabs, a reload, a list in another session, and a layout that
       just became wide never open it. The session is remembered (persisted `task-sidebar` store,
       newest 500), so after he closes it nothing reopens it there, across reloads. A list that
       was emptied and refilled counts as already opened. Not covered: after a reconnect, a live
       update that lands before the timeline page can read as a first list in a session whose
       replica held none.
     - **Explorer retired from the UI.** No button, shortcut, or swipe opens it on any layout. The
       toggles, the swipe, and `Cmd+E` (wide) open the task list through their own store action
       (`openFileExplorerForLayout`, `toggleFileExplorerForLayout`); an explorer request (a review
       attachment, a folder link in the chat) only remembers the checkout's explorer tab and never
       changes a panel. The explorer, diff, PR, commit history, and branch-switcher panes, stores,
       and RPCs stay for upstream cherry-picks; the explorer's tab composition in
       `explorer-sidebar.tsx` and the compact host's checkout model are deleted (no caller left).
       File links in answers open a file tab as before and never needed the sidebar. Browser specs
       that drive the explorer skip where they would open it
       (`e2e/support/helpers/explorer-retired.ts`); `sidebar-workspace.spec.ts` checks the task
       sidebar instead. The iOS agent-device flow `e2e/mobile/agent-device/file-context-menu.ios.ad`
       drives the compact explorer and cannot pass.
     - **No longer reachable** (each can come back on request):
       - the Changes diff view of uncommitted changes, and its compare-against-base mode;
       - its view options: unified or side-by-side, tree or flat list, hide whitespace, wrap long
         lines, expand or collapse all;
       - discarding one file's changes ("Discard changes" in the Changes list);
       - opening the changes as a workspace tab ("Open Changes tab", the working-diff tab);
       - the branch switcher in the Changes header;
       - the commit history ("Commits" section) and opening one commit's diff as a tab;
       - inline review comments on a diff, and the review attachments they put in the composer
         (an existing attachment no longer opens the Changes view);
       - "Add to chat" for a changed file or a file in the tree;
       - the Files tree: browsing, sort, hidden files, refresh, and opening a file from it;
       - file operations from the tree: new file or folder, rename, duplicate, delete, copy path,
         copy relative path, reveal in Finder, download;
       - revealing a folder from a folder link in a chat answer;
       - the PR pane: title and state, checks, pipeline jobs, reviews and approvals, activity
         timeline, refresh. The header's git actions button still shows and acts on the PR
         (view, create, merge), and the left sidebar's PR badge stays.
     - **Checks.** `task-sidebar/auto-open.test.ts` (first live list in the viewed session opens
       once; closing then updating, or clearing and refilling, does not reopen; another session;
       reopen and reload; history replay; compact then wide), `task-sidebar/layout.test.ts` (board
       only in wide focus mode, pinned sidebar only on wide outside focus mode),
       `task-sidebar/viewed-agent.test.ts` (focused pane's active tab, background tab, non-agent
       tab), `stores/panel-store/state.test.ts` (open and toggle per layout without a checkout,
       explorer requests change no panel), `summary.test.ts` (line without
       `Now:`; the sidebar's progress-only line), `sections.test.ts` (section order, order kept
       inside a section, empty sections left out, an unknown state reads as To do, a list without
       states), `task-list-row.test.tsx` (the sidebar row's lines and sizes; the board row
       unchanged). Measured on the dev daemon's request metrics (2026-11-13, wide, a dirty
       checkout, sidebar closed then open, six 30 s windows): no checkout-diff subscription, file-tree,
       branch-list, or PR-timeline request; checkout status and PR status are still requested
       once per load for the header's branch label and git actions button.
     - **Key files:** `packages/app/src/components/explorer-sidebar.tsx`,
       `packages/app/src/composer/task-list/{body,index,summary,sections}.ts{,x}`,
       `components/task-list-row.tsx`,
       `components/sidebar/{sidebar-section-rule,pinned-section-header}.tsx`,
       `packages/app/src/task-sidebar/{auto-open,store,use-auto-open,layout}.ts`,
       `timeline/session-stream-reducers.ts` (`onLiveTaskListAppeared`),
       `task-sidebar/viewed-agent.ts`, `contexts/session-context.tsx`,
       `stores/panel-store/{index,state}.ts` (`openFileExplorerForLayout`,
       `toggleFileExplorerForLayout`, `openFileExplorerForCheckout`),
       `screens/workspace/workspace-screen.tsx`, `panels/{agent,terminal}-panel.tsx`,
       `components/{compact-explorer-sidebar-host,terminal-pane}.tsx`.

102. **A stored passkey never signs in by itself** — the owner's report on 2026-11-13 ("아무리
     ax-dfcorp github 로그아웃 해도 걍 로그인 하면 바로 계정 선택 못하고 ax-dfcorp으로 가버리네 …
     궁극적으로 개선해줘"). GitHub's login page, "Use a different account", and "Add account" signed
     straight back in as ax-dfcorp (network capture: `GET /login?add_account=1&return_to=/login/device`,
     then `POST /session` 302 about 0.6 s later).
     - **Why.** Login pages start a conditional-mediation request on load (passkey autofill). A
       browser leaves it pending until the person picks a passkey; delta 78's authenticator
       answered it at once and the account picker took the most recently used passkey, so no other
       account was reachable and sign-out did not hold. Electron 44's request delegate drops the
       request's mediation (it overrides neither `SetUIPresentation` nor conditional dispatch), so
       nothing browser-side says conditional or modal.
     - **Measured on 44.10.2** (standalone script, then the harness). `select-webauthn-account`
       fires for every discoverable get(), one account and conditional included; the request stays
       pending until the callback runs and resolves when it is called seconds later; a late
       callback for a request the page aborted is a no-op. `navigator.userActivation.isActive` reads
       true for a request a click or key started (person, CDP input, or the agents' user-gesture
       background click) and false after a page load and after a link navigation, but it survives
       a same-document navigation: after a click on a `pushState` "Sign in" link the login view's
       autofill still read true (harness). Electron's `input-event` fires for CDP-dispatched and
       `sendInputEvent` input on a guest; a user-gesture page script raises none. Presence
       simulation off: the request never reaches the picker and turning presence on does not revive
       it, so that route was rejected. No wrapper around `navigator.credentials.get`: page-visible
       built-ins are what bot checks compare (delta 81).
     - **Rule.** The account picker is the hold point. A request counts as asked for when the tab
       has transient user activation and its main frame has not navigated (full or in-page:
       `did-navigate`, `did-navigate-in-page`) since the tab's last gesture. Gestures are recorded in
       main: Electron's `input-event` (person and CDP input, the phone's remote input) and the
       automation adapter's user-gesture scripts (an agent's click or drag). Activation is read in
       an isolated world through CDP, beside the tab's CDP queue rather than in it, so a long command
       cannot outlast Chromium's 5 s activation window; a failed read counts as none. Asked for with
       one stored account: answered at once. Asked for with two or more: waits 60 s for a choice
       (`choose_account`). Activation but a navigation after the gesture, or an activation no
       recorded gesture explains: waits 60 s for confirmation even with one account
       (`navigated_after_gesture`). Both show a card in the tab's pane (delta 93's placement, its own
       `browser-passkey-choice` event): one account shows its name with Cancel and Sign in, several
       show one button each and Cancel; names are shown as stored, and agent results mask them.
       `browser_passkeys use` answers either. No activation (page load, link navigation): waits with
       no deadline and no card, as autofill does, until `browser_passkeys use` answers it. A newer
       request from the same frame, a navigation, or a closed tab ends the held one. A site with no
       stored passkey still fails at once (the picker never runs), registration is unchanged, and a
       request that names the credential in `allowCredentials` never reaches the picker and is
       answered as before.
     - **Records.** The authenticator signs before the picker runs, so the counter still moves (and
       syncs to the other tabs) on every assertion, but `lastUsedAt` is set when the assertion
       reaches the page, or at the signature for a credential loaded non-discoverable, which only an
       `allowCredentials` request reaches.
     - **Protocol.** New command `passkey_use` (`browserId`, optional `account`) gated through
       `browserHost.supportedCommands` like `network_export`, and an optional `request` on the
       passkeys status tab; the tool exposes it as `browser_passkeys` action `use` and masks account
       names in results. Wire ledger updated.
     - **Not covered.** A site whose only passkey route is autofill offers the person nothing in the
       tab (Electron has no autofill dropdown); its passkey button or an agent's `use` signs in. A
       site that shows its login view after a click without any navigation (no `pushState`, no
       hash change) and starts autofill within 5 s is answered at once; client-side routers change
       the URL, which this rule catches. A held request the page aborted stays in `status` until the next request
       from that frame or a navigation, and `use` on it signs in nothing.
     - **Checks.** `passkeys.test.ts` (waits without a gesture, at once with one account, a choice
       with two, pane answer, Cancel, expiry, same-frame replacement, navigation, foreign account,
       unreadable activation, `lastUsedAt`), `service.test.ts`, protocol, broker, and tools tests,
       `passkey-choices.test.ts`; capture harness group `passkeys` (autofill on load waits 3 s and
       `use` answers it, a modal request without a gesture waits, the background click on the
       passkey button signs in and aborts autofill, a `pushState` "Sign in" link followed by autofill
       300 ms later stays signed out as `navigated_after_gesture` with the card shown, a CDP trusted
       click on the passkey button signs in at once, two accounts wait and the named one signs in,
       the pane surface shows and hides).
     - **GitHub, observed** (throwaway session, a synthetic discoverable `github.com` credential with
       a random key, the picker wrapped so it could only answer null; no form submitted). `/login`
       loaded directly, the header "Sign in" link from `/` (`href=/login`, a trusted click), and
       the owner's `/login?add_account=1&return_to=%2Flogin%2Fdevice` were each a full document load
       (`did-navigate`, then two in-page `replaceState` navigations). In this fresh session GitHub
       called `credentials.get` in none of them (`isConditionalMediationAvailable()` true, the
       `js-conditional-webauthn-placeholder` form present, the username field's autocomplete plain
       `username`), so the picker never fired and no POST was sent: GitHub starts passkey autofill
       only for a browser it already knows, which a throwaway session cannot reproduce. For the
       owner's flows, which were full loads here, the new document has no activation, so the
       request waits silently (`no_gesture`). Real site, webauthn.io with the compiled hub in a
       throwaway session: after a reload the page posted only `/authentication/options` for 6 s and
       stayed signed out; Authenticate posted `/authentication/verification` 0.36 s later and showed
       "You're logged in!".
     - **Key files:** `packages/desktop/src/features/browser-automation/{passkeys,passkey-choice-surface,service,ipc}.ts`,
       `packages/desktop/src/{main,preload}.ts`, `packages/protocol/src/browser-automation/rpc-schemas.ts`,
       `packages/server/src/server/browser-tools/{broker,tools}.ts`,
       `packages/app/src/desktop/browser/{passkey-choices.ts,panel.tsx}`,
       `packages/app/src/desktop/browser/pane/{index,passkey-choice-card}.electron.tsx`,
       `packages/app/src/desktop/host.ts`; capture harness group `passkeys`. Card screenshots and the
       pixel critic's verdict: `~/.pi/agent/tmp/ui-critic/2026-11-13-passkey-card/`.
103. **A research worker archives itself once its report has reached the lead** — the owner's
     ask on 2026-11-13 ("리서치 워커 자동 보관되게 해줘 어차피 이어서 안하잖아"). The
     research-fanout lead archived each worker when its notice arrived, which was late whenever
     the lead was busy in another turn, and 27 of 1,232 workers were never archived.
     - **Option.** The agent-scoped MCP `create_agent` takes `archiveOnFinish` (default false; the
       canonical and the legacy placement shapes). Top-level creation rejects it, and the WebSocket
       `autoArchive`, schedules, the app, and `packages/protocol` are unchanged. The child carries
       the server label `paseo.archive-on-finish=true`, so every finish watcher for it archives it:
       the one `create_agent` starts, a `send_agent_prompt` follow-up's, and one re-armed or
       delivered by restart recovery (delta 44). A later prompt unarchives and runs it as before,
       and that turn's finish archives it again.
     - **Order.** The archive runs after the finish notice has been handed to the caller, or when
       the caller is archived and can never receive it; never before, because the notice reads the
       child's last message, which is gone once the child leaves the manager. It rides on the
       existing finish moment: background waits still hold it (delta 29), a `[lead review]` notice
       does not archive and the quiet end after it does (delta 80), and permission, stall, and
       "was closed" notices never archive. An errored child is reported and archived, so that
       notice ends the watch and says so instead of "Daseo keeps watching"; the finished notice is
       unchanged. A detached child ("not-owned") and a failed delivery are not archived.
     - **Without `notifyOnFinish`.** The child is archived when its first turn ends or errors and
       it holds no background wait. This path is one-shot and not journaled across a restart.
     - **Archive path.** `archiveAgentCommand`, the command behind `archive_agent`, so the
       snapshot, cascade, and client updates match a manual archive.
     - **Key files:** `packages/server/src/server/agent/agent-prompt.ts`
       (`ARCHIVE_ON_FINISH_LABEL`, `archiveFinishedChild`, `archiveAfterFirstTurn`,
       `deliverFinishNotification`), `create-agent/create.ts`, `tools/paseo-tools.ts`,
       `restart-recovery-runner.ts`; tests in `agent-prompt.test.ts` ("archiveOnFinish (delta
       103)"), `create-agent/create.test.ts` (real agent manager: the parent's notice arrives while
       the child is still idle, then the child is archived), and `mcp-server.test.ts`. pi-local's
       research-fanout skill passes the argument; its lead-side archive stays as the fallback for
       older daemons. Takes effect with the next release and daemon restart.

104. **An action can answer with the settled page, and `browser_wait` can wait until the page
     settles** — the 2026-11-13 browser-turns study (Hark Handoff² comparison): over 30 days 63% of
     browser turns did one action, model time per turn was 4.5 s median against 0.07 s in the
     tool, and the waste was "act, then a separate turn to look" and fixed pauses. A PoC (128 runs,
     8 tasks, Opus 5.5 and Fable 5.2) measured turns -15.8% (95% CI -23.9..-8.3), model time
     -18.6%, output tokens -19.0%. Description-only wording measured 0.0% and a batch tool no
     significant gain, so neither was built. Opt-in only; without the new arguments every result is
     unchanged.
     - **`snapshot: true`** on `browser_click`, `fill`, `type`, `keypress`, `select`, `hover`,
       `scroll`, `navigate`, `back`, `forward`, `reload`, `handle_dialog`, and `new_tab`. The
       desktop arms the tab's request tracker before the action (a fetch the action sends counts),
       runs it, waits for the page to settle (at most 4 s), and adds the whole-page snapshot as the
       optional `pageAfter` on the response; the tool text appends it under "Page after the action
       (settled in Nms):" after the effect line, open dialog, and tab events. A failed action
       returns as before; one that leaves a confirm or prompt open returns at once with
       `openDialog` and "Snapshot skipped"; a dialog the page opens while it settles is held or
       answered as during any command. A navigation's snapshot is the new document. `new_tab` is
       opened by the app runtime, so the tool follows it with a `settle` on the new tab. `drag`,
       `upload`, and `evaluate` do not take it (not in the measured set).
     - **`browser_wait settled: true`** sends the new `settle` command (`timeoutMs`, default 5 s,
       cap 30 s). A page that does not settle is a `browser_timeout` naming what kept it busy
       (still loading, N requests in flight, or the DOM changed N ms before the end), like the
       other conditions.
     - **Settled** (`page-settle.ts`): not loading, no request sent since arming in flight for
       200 ms, and the DOM unchanged for 200 ms with `readyState` complete, both windows running at
       once, so a quiet page settles in about 200 ms. The DOM side is one MutationObserver per
       document (child list, attributes, text) over the document, same-origin frames, and open
       shadow roots, installed by the first probe and read by one probe at a time from the main
       frame. Network quiet is 200 ms rather than networkidle's 500 ms because every request after
       arming is counted while in flight, and content that arrives late re-arms the DOM window. A
       main-frame navigation restarts both windows; arming waits at most 1 s each for the
       debugger and the page, and a tab whose requests cannot be watched settles on loading and
       the DOM and says `networkWatched: false`. No `Runtime.enable`.
     - **Deadline.** The broker adds 11 s (4 s settle, 5 s snapshot, 2 s arming and transport) to a
       command sent with `snapshot`, so it never meets the generic 15 s expiry because of the wait;
       `browser_wait settled` asks for its timeout plus 3 s.
     - **Older desktop.** It does not advertise `settle`, so the broker refuses `settle` and any
       action carrying `snapshot` with `browser_unsupported` before sending (the action does not
       run); an older daemon never sends either. `packages/protocol`: optional `snapshot` args,
       the `settle` command and result, optional `pageAfter`; wire ledger rationale updated.
     - **Ref wording.** The descriptions said refs "expire when the page changes". Refs stay on
       their element for the document's life; a snapshot keeps the refs it lists and find adds its
       matches. `browser_snapshot` now says that in full; the action tools say "stay valid while
       the element stays on the page".
     - **Checks.** Capture harness group `page-settle`, 5 of 5 on 2026-11-13: a quiet page settled
       in 217 ms; a click whose fetch takes 600 ms answered in 883 ms with the rendered result in
       its snapshot; a ticker page ended at 1503 ms against a 1500 ms bound; a navigate to a page
       that renders 300 ms after load held that content; a click without the argument had no
       `pageAfter`. Unit tests in `page-settle.test.ts` (jsdom: quiet, late request, DOM that
       stops, never quiet, navigation mid-wait, same-origin iframe, unwatched network, a debugger
       that does not answer, abort), `page-commands.test.ts`, `service.test.ts`, the server
       `tools.test.ts` and `broker.test.ts`, and `rpc-schemas.test.ts`.
     - **Key files:** `packages/desktop/src/features/browser-automation/{page-settle,service}.ts`,
       `packages/protocol/src/browser-automation/rpc-schemas.ts`,
       `packages/server/src/server/browser-tools/{tools,broker}.ts`,
       `packages/desktop/capture-harness/main.js`.

105. **The phone app's left sidebar is narrower** — the owner's ask on 2026-11-13 about the
     unfolded Fold 7 (875 dp wide): "왼쪽 사이드바 너비를 좀 줄이고". The pinned left sidebar's
     default on the native app is 260 (it was 320, over a third of that screen); the web app and the
     desktop app keep 320. The panel store's persist version goes 12 -> 13, and its migration moves
     a native width of exactly 320 to 260, since that is the old default nobody chose by hand; any
     other width stays, and a missing width takes the platform default. Checks in
     `stores/panel-store/state.test.ts` (native 320 at v12, a custom native width, web 320, a
     missing width, a native 320 already at v13). Key files:
     `packages/app/src/stores/panel-store/{state,index}.ts` (`DEFAULT_NATIVE_SIDEBAR_WIDTH`,
     `defaultSidebarWidth`, `migratePanelSidebarWidth`).

106. **A lead hears every finished turn of its sub-agent** — the owner's report on 2026-11-14
     ("워커는 작업을 끝내고 가만히 있는데 리드가 그걸 모르고 주구장창 기다리는 경우가 종종 있다").
     The finish watcher ended at its first "finished" notice, so every later turn of the child that
     the lead had not started ended silently. Evidence (audit
     `brain/Memory/Agent/personal-root/lead-missed-child-finish-audit-2026-11-14.md`): 2026-11-13
     lead `01a1afcb-789a` / implementer `01a1d234-e260` got "the critic is running" at 15:20 KST;
     the critic's notice restarted the implementer, whose final `[lead review]` report at 15:30
     reached nobody until the owner asked at 17:24 (same shape: lead `01a1d237-3f69` / child
     `01a1d361-15de`). From 2026-10-25 to 11-14, 55 report-like turn ends of 477 non-research
     children followed a terminal notice with no notice; the first restart cause was the child's
     own sub-agent's notice in 12 and its own wait wake in 6, and 17 were found only because the
     owner wrote. Separately, child session `01a1d1b0-0857` at 2026-11-12 22:11:04Z registered a
     wait (`1 wait(s) pending`) and in the same second received a wake built earlier with
     `pending=0`; the count dropped to 0, "finished" went out at 22:11:05, and the final report at
     22:13:25 was never announced (the lead sat idle 27 minutes).
     - **A watch lasts as long as the parent-child relation.** After a notice the watcher keeps
       listening. It owes the caller a finish from `create_agent` or a `send_agent_prompt` with
       notify-on-finish until one is delivered (a failed delivery stays owed and the next turn end
       retries it). After that, a turn end is reported only when its last message differs from the
       last report the caller received (compared by a sha256 prefix) and is not empty or exactly
       `[wait noted]`, and only to the child's own parent: a follow-up to an agent the caller does
       not own reports that one turn, as before. A `send_agent_prompt` with `background: false`
       (the tool returns the result) or `notifyOnFinish: false` marks that turn as read by the
       caller. A new request for the same pair refreshes the live watcher (delta 80's one watcher
       per pair); it no longer replaces it.
     - **A child waiting on its own sub-agents is not finished.** Its watched sub-agents (watches
       whose caller is the child, with a finish still owed) hold its "finished" like background
       waits do (delta 29), with the same `[lead review]` release at once (delta 80). The hold ends
       when their finish, error, review, or close notice has been sent to the child, or when their
       watch ends without one (not owned, caller archived, a failed delivery). A sub-agent with no
       activity for 61 minutes stops holding; a timer re-checks the held child at that moment, so
       the cap does not wait for the next state change (the background-wait cap does).
     - **A wake's stale count no longer erases a newer wait.** The Pi adapter never lowers the count
       from a wake below the waits it saw registered and not yet settled; a wake's `pending` is
       computed when pi-local builds it, before a registration that reaches the adapter first. Tool
       results (`wait_for`, `wait_cancel`, `wait_status`) are computed when the tool runs and stay
       authoritative, and they also trim an id whose end the adapter never saw (waits lost in an
       in-process reload). A matching output line (`fired`) keeps its wait; exit and timeout settle
       it. pi-local is unchanged.
     - **Which idle sends which notice:**

       | Child event                                                 | Notice to the caller                                         |
       | ----------------------------------------------------------- | ------------------------------------------------------------ |
       | idle with background waits or watched sub-agents pending    | none; a `[lead review]` report: "is waiting for your review" |
       | idle, a finish owed                                         | finished                                                     |
       | idle, nothing owed, a new report, child owned by the caller | finished                                                     |
       | idle, nothing owed, same report, empty, or `[wait noted]`   | none                                                         |
       | idle after a turn the caller read itself or declined        | none                                                         |
       | error, permission request, 20 min silent while running      | errored, needs permission, stall (unchanged)                 |
       | closed while a finish is owed or the child is held          | was closed; the watch ends                                   |
       | closed otherwise, caller archived, child no longer owned    | none; the watch ends                                         |

       An `archiveOnFinish` child keeps delta 103 exactly: its first finish or error is its last
       notice, then it is archived.

     - **Bounds.** A watch ends when the child closes or is archived, the caller is archived, or the
       child is detached. A continuing watch (nothing owed, nothing held, no turn running) ends
       after 7 days with no child activity, and at most 500 watches live per daemon: the quietest
       continuing one makes room. An idle unload keeps the watch (it emits no close). Registries
       are per agent manager.
     - **Journal.** Entries carry `finishOwed` and `lastReportHash` and are updated when they
       change; an entry written before this delta reads as owed. Restart recovery re-arms a
       continuing watch without loading its child, re-arms a woken child's watch with its state,
       and after delivering an owed finish re-arms the parent's continuing watch.
     - **Logs.** `finish_watch.ended` (child closed, caller-gone, quiet, evicted),
       `finish_watch.not_delivered` (caller-gone, not-owned) at info; `finish_watch.held` and
       `finish_watch.repeat_suppressed` at debug.
     - **Key files:** `packages/server/src/server/agent/agent-prompt.ts`
       (`setupFinishNotification`, `callerReadsNextTurn`, `finishReportHash`,
       `SUB_AGENT_HOLD_MAX_MS`), `tools/paseo-tools.ts`, `restart-recovery.ts`,
       `restart-recovery-runner.ts`, `providers/pi/agent.ts` (`recordBackgroundWaits`); tests in
       `agent-prompt.test.ts` ("a watch lasts as long as the parent-child relation", "a child
       waiting on its own sub-agents is not finished"), `restart-recovery.test.ts`, and
       `providers/pi/agent.test.ts` ("a wake built before a new registration does not erase it").
       Takes effect with the next release and daemon restart. Leads on the old skill text may get
       more notices; each reads like today's "finished".

107. **A parked popup renders while it is awake** — the lead's report on 2026-11-14: Google sign-in
     on dashboard.capsolver.com never finished. Its `/passport/oauth2/google` callback posts to the
     opener from `requestAnimationFrame` and closes; in Daseo the callback never ran. Measured with
     a two-site repro (opener on `127.0.0.1`, identity page on `localhost`, callback back on the
     opener's site): in 0.5.117 and in a fresh dev build the parked popup rendered 0 frames per
     second with `visibilityState` "visible" and 10 timer ticks a second, `browser_screenshot`
     answered "has not painted yet", and the same callback without rAF reached the opener in 569 ms.
     The hidden parking window was not the cause: a bare Electron 44.10.2 popup in the same window
     rendered 75 fps. Bisecting the adoption path pointed at `preparePaseoBrowserWebContents`,
     whose lifecycle `track` calls `webContents.setBackgroundThrottling(false)`.
     - **Two Electron behaviors.** (1) With throttling turned off by that call (at adoption, or by
       a lifecycle throttle followed by a wake), Electron sets `disable_hidden_` on the popup's
       widgets, so the opener-site widget Chromium swaps out when the popup leaves for the identity
       provider is never hidden. The return navigation reuses it, nothing shows it again, and its
       surface is never embedded: no frames until the popup leaves that site again. Hiding and
       showing the view or toggling the flag did not recover it; the `webPreferences` value at
       creation did not cause it. (2) A popup moved from the app window back into the never-shown
       parking window (presented, then the user switched away) is hidden by Chromium and never
       shown again: `visibilityState` "hidden", 0 frames, with any throttling setting.
     - **Mechanism.** Popups keep Chromium's default throttling for their whole life; the popup
       options no longer carry `backgroundThrottling: false`. For a popup the lifecycle's "throttling
       off" is a paint hold: CDP `Emulation.setFocusEmulationEnabled` on its own debugger session,
       which Chromium implements as a visible capture, so the page renders and reports visible
       wherever its view sits (the state of a tab being recorded). The hold is taken while the
       popup is awake and parked and released while it is presented, so a popup the user looks at
       keeps real focus and blur. Idle steps are unchanged: throttled after 2 minutes releases the
       hold, frozen after 15 stops rendering, the next command, capture, stream, or presentation
       wakes it and takes the hold again. A held page reports `document.hasFocus()` true, as a
       Chrome popup window does when it opens. Rejected: parking inside the app window (a child
       view at index 0 still paints over the app page, measured), a view outside the window bounds
       ("hidden", measured), and a shown transparent window (not tried: it would show in Mission
       Control and the window switcher).
       `webContents.incrementCapturerCount` no longer exists in Electron 44.
     - **Crash found on the way.** Re-attaching the debugger from its `detach` event while the
       popup closes (reason "target closed") crashed the main process (SIGSEGV). The hold ignores
       that reason and re-applies after any other detach one macrotask later, only to a live popup.
     - **Measured after the change** (dev build, 2026-11-14): the rAF callback reached the opener
       in 360-583 ms and the popup closed in 402-603 ms, from an agent tab in the foreground
       workspace and in a background workspace; a parked popup rendered 150 frames in 2 s and,
       left alone, froze (longest frame gap 1588 ms) and rendered 149 frames in 2 s after a
       command woke it. App CPU with five parked popups, percent of one core over 20 s: awake
       11.1 (animated page) and 10.7 (static), frozen 2.5 and 1.9; before the change 11.6 and
       11.4, frozen 2.5 and 2.4 (those popups painted before too, since they made no cross-site
       return). Turnstile on `/passport/change-password` (the lead's "Captcha Loading") issued
       its token in 1.2-1.8 s in 0.5.117 in a root tab and in a parked popup: not reproduced,
       nothing changed for it.
     - **Tests.** `packages/desktop/e2e/browser-tabs.e2e.mjs` runs a last phase after Playwright
       disconnects, because Playwright attaches focus emulation to every new page and would keep a
       parked popup painting by itself: an OAuth round trip from each workspace within 2 s, frames
       in a parked popup and in a background-workspace tab, host focus kept (read through one plain
       CDP session on the app renderer), and the idle freeze and wake. With the old popup options
       restored it fails at the first round trip. Unit tests: `popup-painting.test.ts`.
     - **Key files:** `packages/desktop/src/features/browser-webviews/popup-painting.ts`
       (`PopupPaintHold`, `shouldHoldPopupPainting`), `browser-webviews/index.ts`
       (`createPopupPaintHold`, `preparePaseoBrowserWebContents` `popup`), and `main.ts`
       (`getBrowserPopupWindowOptions`).

108. **Durations take a day unit** — the lead's tool-failure audit on 2026-11-14: agents sent
     `expiresIn: "2d"` or `"3d"` to schedule and heartbeat tools four times in two weeks, and each
     call failed with "Invalid duration format". `parseDurationString` adds `d` (24 hours) to its
     units, so `2d` is 172,800,000 ms and `1d12h` is 36 hours; the error's examples list `2d` and
     `1d12h`. Every string without a digit-plus-`d` part parses as before, including the old scan's
     habit of accepting a string with any match and ignoring the rest (left alone on purpose:
     tightening it is a separate change). A string that already mixed a day part with another unit
     now counts the days too (`1d2h` was silently 2 hours, now 26); none appeared in the audited
     calls. Bounds are the callers' as before (`every` must still map to five-field cron, `48h` and
     `2d` give the same result). Checks in `agent/mcp-shared.test.ts`. Key file:
     `packages/server/src/server/agent/mcp-shared.ts` (`parseDurationString`).

109. **Every Pi slash command answers in Daseo** — the owner's ask on 2026-11-14 ("걍 다
     통일되게, 다 통하게"): `/reload` typed in Daseo reached the model as prompt text and cost a turn.
     Pi's interactive mode handles its 24 built-ins (Pi 1.5.2 `BUILTIN_SLASH_COMMANDS`) itself;
     RPC `get_commands` lists only extension, prompt-template, and skill commands, and the daemon
     handled only `/compact` and `/autocompact`.
     - **Table.** `PI_BUILTIN_COMMANDS` gives each built-in one handling, and autocomplete lists
       all of them. Run through the agent manager, so the client sees the same state as after
       the matching UI action: `/reload` (the "Reload agent" path: a new Pi process on the same
       session file, so extensions, skills, prompts, and context files are read again; refused
       while a turn runs; background waits are reported as with any reload), `/model [x]`
       (provider/id, bare id, display name, or a unique part; several matches are listed, never
       guessed), `/thinking [level]` (checked against Pi's levels for the model), `/name <x>`
       (Pi session name, tab title, and for a top-level agent the workspace title, locked as
       manual like a sidebar rename). Run in Pi: `/compact`, `/autocompact`, `/export [path]`
       (HTML through RPC; a `.jsonl` path copies the session file and never overwrites). Shown
       in the timeline: `/session` (state and stats), `/changelog` (newest section of the
       CHANGELOG.md next to the `pi` on PATH), `/hotkeys` (where Daseo lists shortcuts).
       Answered with where Daseo does it: `/tree` and `/fork` ("이 메시지로 되감기"; RPC `fork`
       and `clone` swap the session file under Daseo's record and timeline, so they never run),
       `/clone`, `/resume` and `/import` (세션 가져오기), `/copy` (the server cannot reach the
       device clipboard), `/share` (publishes outside; no confirmation route, so `/export`
       instead), `/settings`, `/scoped-models`, `/login` and `/logout` (`pi auth login`, plus
       the extension commands whose names hold auth, login, logout, or account), `/trust`,
       `/bug`. `/new` and `/quit` stay the client's aliases of `/clear` and `/exit`; the server
       answers only their argument forms.
     - **Unknown commands.** A prompt is a command candidate only when it starts with `/name`,
       the name an ASCII letter then letters, digits, `_`, `:`, `.`, or `-`, followed by
       whitespace or the end; `/Users/me/a.txt` and `/폴더` stay text. A candidate that is
       neither a built-in nor in the RPC list is stopped only when it looks like a typo: one
       edit (a changed, missing, extra, or swapped letter) from a known name, and four letters
       or more. It is answered "/x 명령은 없습니다" with "혹시 이 명령인가요: /y" and how to send
       it as text: a word before the slash, because the client trims a leading space. Every
       other unknown `/word` goes on as before: the Claude Code harness behind the Pi bridge
       answers its own commands (`/code-review`, `/loop`, `/init`, about 40), and `/tmp 봐줘` is
       text. Prefix and substring matches never stop a prompt (autocomplete offers those), and
       two edits were too loose (`/effort` hit `/export`, `/rename` hit `/name`). Claude Code
       commands that share a built-in's name (`/model`, `/resume`, `/export`, `/login`, `/bug`)
       are now Daseo's. The RPC names are cached at session start, on every autocomplete
       listing, and after a relaunch; before the first answer arrives the prompt goes to Pi as
       before. An extension, template, or skill whose name equals a built-in keeps running in Pi.
     - **Senders that are not the timeline.** Out-of-band handling sits in `startAgentRun`, so
       it sees the composer, MCP `send_agent_prompt`, and MCP or app `create_agent` initial
       prompts. Schedules, heartbeats, finish and recovery notices, and `wait_for` wakes never
       reach it: they arrive wrapped in `<paseo-system>` (wakes inside Pi), and a new-agent
       schedule runs its prompt through `runAgent`, so an extension command in a scheduled
       prompt runs in Pi as before. A command answered out of band starts no turn, so
       `send_agent_prompt` and `create_agent` now return its reply as `lastMessage` with
       guidance saying no turn ran, set up no finish watch, and do not wait for a run. Before,
       a blocking call waited for a turn that never came and a notified caller heard nothing.
       `tryRunOutOfBand` hands the replies to its caller through an optional callback.
     - **Also.** An out-of-band prompt no longer feeds workspace auto-naming (delta 37). Replies
       are Korean timeline messages. No protocol or client change: the out-of-band context
       gained an optional `host` inside the daemon only, so Mac, web, and phone behave alike.
     - **Upgrade check.** `~/ws/pi-local` `npm run doctor` imports this table and the installed
       Pi's `BUILTIN_SLASH_COMMANDS` and warns with the names Daseo lacks (2026-11-14: 24 of
       24). A doctor check, not a Daseo test: it reads the Pi that Daseo launches, which CI does
       not have, and doctor is what runs after a Pi upgrade.
     - **Tests.** `builtin-commands.test.ts` (table, parsing, typo rule),
       `builtin-command-runner.test.ts` (per-command behavior), Pi `agent.test.ts` (routing,
       Claude Code and path pass-through, the word-before-slash escape), one
       `agent-manager.test.ts` case for the host rename, and `mcp-server.test.ts` and
       `create.test.ts` for the reply to MCP senders.
     - **Key files:** `packages/server/src/server/agent/providers/pi/builtin-commands.ts`,
       `builtin-command-runner.ts`, Pi `agent.ts` (`tryHandleOutOfBand`), `agent-manager.ts`
       (`createOutOfBandHost`, `setWorkspaceTitleSetter`, `tryRunOutOfBand`), `agent-prompt.ts`
       (`OUT_OF_BAND_GUIDANCE`), `tools/paseo-tools.ts`, `create-agent/create.ts`,
       `bootstrap.ts`. Takes effect with the next release and daemon restart.

110. **Agents reach elements inside cross-origin iframes** — the lead's report on 2026-11-14: on
     Fly.io's Stripe Checkout the whole card form sits in one cross-origin iframe, the snapshot
     showed it as one line with no refs, `browser_find` found nothing, and keys sent after focusing
     the iframe never entered it, so no tool (and so no `browser_fill_secret`) could fill it.
     Payment forms, embedded sign-in widgets, and embedded editors all use this pattern.
     - **Snapshot and find.** A cross-origin iframe's content now appears under its iframe line,
       and its refs carry the frame: `@f1e3` (Playwright MCP's convention). The page's script marks
       each cross-origin iframe with its window path (its index in `parent.frames` at each level
       from the top, all readable across origins); the host matches the path to an Electron
       `WebFrameMain` by running the same path script in the frame, then runs the frame's own copy
       of the snapshot or find script there. Frames share the page's 1,500-node, 500-ref, and
       80,000-character limits in document order; frames under 2 px on a side or placed above or
       left of the page (Stripe's controller, invisible captchas) stay one line; at most four frame
       levels; a frame that does not answer in 3 s stays one line. A page without cross-origin
       iframes runs the same single script as before. Frame numbers stay with the frame
       (`frameTreeNodeId`) for the tab's life, like element refs.
     - **Actions.** click, fill, type, select, hover, keypress, scroll, evaluate and read with a
       ref, and `browser_find` work on frame refs; the element check runs in the frame, and each
       iframe boundary above it is crossed by the parent's script (finds the iframe element showing
       that window, checks it is visible, still, on screen, and not covered, and moves the point by
       its border and padding), so trusted input lands at tab coordinates. Background clicks and
       fill run in the frame with its own event classes. `browser_evaluate` without a ref stays in
       the main frame; no "run in any frame by URL" escape was added. drag, upload, styles, and an
       element screenshot refuse a frame ref with `browser_unsupported` (each needs DevTools
       access inside the frame that the main session does not have). `browser_wait text` also
       looks inside the tab's frames, every eighth poll (about 200 ms).
     - **Text and keys.** The tab's own input reaches every frame in the page's renderer, so a
       cross-origin but same-site iframe (js.stripe.com inside checkout.stripe.com) takes typed
       text as before. A frame in another renderer process (another site, so Stripe's form on a
       shop's page) gets nothing from `sendInputEvent`, and `webContents.insertText` while such a
       frame has focus crashed the tab's renderer (Electron 44.10.2, exit code 11, measured). Its
       text (`Input.insertText`) and keys (`Input.dispatchKeyEvent`) now go through its own DevTools
       target: attached with `Target.attachToTarget` for the one input and detached after, chosen
       among the browser-wide iframe targets by a random key the frame's own script set a moment
       before (a URL can be open in two tabs). No `Runtime.enable`. `browser_type` and
       `browser_keypress` without a ref, and the phone's streamed text and keys, follow the page's
       focus into such a frame the same way; before, the phone typing into a tapped card field hit
       the same renderer crash, and the phone's focus probe now asks the focused frame itself, so a
       tapped card field keeps the phone keyboard up. Focus in an iframe that cannot be matched
       fails with a message instead of risking the crash.
     - **Values.** A filled field inside a frame prints in a snapshot exactly as in the main
       document: the value is its name only when it has no label, aria-label, or placeholder
       (Stripe's fields have aria-labels). No special casing.
     - **Protocol.** The ref pattern widens from `@e\d+` to `@(?:f\d+)?e\d+` in
       `packages/protocol` and the server's tool schema; only a desktop with this delta hands out
       `@f` refs. `browser_snapshot`'s description says which tools take them; `browser_wait`'s says
       text includes iframes.
     - **Checks.** Capture harness group `cross-origin-frames`, 8 of 8 on 2026-11-14 (fixture, see
       `docs/browser-capture-harness.md`). The `frames-network` group now expects the cross-origin
       frame's content with frame refs. Stripe's public test-mode payments demo
       (`stripe-payments-demo.appspot.com`, card frame from js.stripe.com in its own process) in the
       compiled build: refs `@f1e1`-`@f1e3` for card number, expiry, CVC; typing 4242424242424242,
       1234, 123 by ref gave `4242 4242 4242 4242`, `12 / 34`, `123`, each `is-complete` with
       `aria-invalid="false"`. Unit tests: `frame-input.test.ts`, frame cases in
       `snapshot-engine.test.ts`, `aria-snapshot-script.test.ts`, `service.test.ts`,
       `trusted-input.test.ts`. Snapshot of pages without cross-origin iframes is unchanged:
       example.com, Wikipedia "Electron (software framework)", and Python's `json` docs gave the
       same node, ref, and character counts in 0.5.120 and this build (18/1/1,032,
       1,500/111/18,926, 1,500/23/6,300).
     - **Key files:** `packages/desktop/src/features/browser-automation/{frames,frame-input}.ts`
       (new), `snapshot-engine.ts`, `aria-snapshot-script.ts`, `actionability.ts`
       (`waitForActionableRefTarget`, frame carry), `service.ts` (`resolveRef`, `keyboardRoute`),
       `ipc.ts` (`listFrames`, `sendFrameInput`), `trusted-input.ts` (`planCdpKeySteps`).
       Already-open tabs need no reload.

## Local reliability contracts

- The generated WS outbound validator must accept every `AgentAttachmentSchema` branch, including
  the `.transform()`-wrapped text attachment. zod-aot 0.20.4 dropped transformed members from the
  generated discriminator dispatch, so any timeline page holding a browser-element, workspace-file,
  PR-context or chat-history attachment failed validation and took the whole page with it. The pin
  stays at or above 0.20.5 and `packages/protocol/tests/validation/ws-outbound.test.ts` covers both
  the compiler behaviour and every attachment branch on real timeline messages.
- Compaction progress never becomes permanent scrollback. The provider closes an open compaction on
  a second start, a terminal turn, and process exit; the daemon closes rows still marked `loading`
  when it seeds a timeline from durable storage; the app closes only the rows owned by the turn that
  ends and renders only terminal rows, showing a live compaction as turn-footer status instead. A
  terminal row carries `outcome` (`failed`/`canceled`, absent for success) while the wire `status`
  stays `loading | completed`, so an interrupted compaction stops reading as a successful one without
  breaking an older app. This is the fix for a Mac that halted mid-compaction leaving "압축하는 중"
  on screen indefinitely. See [docs/timeline-sync.md](docs/timeline-sync.md#compaction-progress-is-not-history).
- A manual `/compact` is visible for its whole duration and does not reject the next prompt. The
  turn footer mounts on an active compaction even with no foreground turn, so the spinner, the
  "압축하는 중" label, and the compaction's own elapsed clock stay on screen; the completed marker
  then carries the duration. Pi rejects a prompt outright while it compacts, so the daemon parks it
  in a single slot and sends it at `compaction_end` — including a failed or canceled one, because Pi
  is idle again either way. `startTurn` still returns its turn id immediately, so the daemon opens
  the turn and records the submitted prompt as usual: the user's row clears "보내는 중" and reads as
  an ordinary sent message while the footer shows "압축하는 중". There is no queued state. Turn
  cancellation and process exit clear the slot through their existing terminal paths. Key files:
  `packages/app/src/agent-stream/view.tsx`, `packages/app/src/types/stream.ts`, and
  `packages/server/src/server/agent/providers/pi/agent.ts`.
- Transcript file links open the file the agent named. Reads through the file explorer service may
  leave the workspace root as long as they stay under the daemon user's home directory or the OS temp
  directory (`~/.pi/agent/plans/…`, `~/brain/…`, `/tmp/…`); a symlink or path into anything else
  is still refused, and every write, rename, create, and delete stays confined to the workspace
  root. Outside paths are echoed back in absolute form. On the app side, inline-code tokens may
  contain spaces when they still read as one path (`docs/최종 보고서.md`, never a command line),
  document/data/media extensions link like source files and any short extension counts once a
  directory is named, and a directory-qualified relative path that the gitignore-aware suffix
  search cannot find (`tmp/report.md`, `.secrets/x.env`) opens directly instead of toasting "no
  file found". A genuinely missing file shows "파일을 찾을 수 없습니다: <path>" in the file pane rather
  than a raw ENOENT. Relay/mobile clients share this read scope: a phone with the E2E key can read
  the same home files the agent already can. Key files:
  `packages/server/src/server/file-explorer/service.ts`,
  `packages/app/src/assistant-file-links/{parse,resolver}.ts`, `packages/app/src/file-pane/pane.tsx`.
- One prompt is one row even when a provider forgets it. A respawned Pi process re-delivers the
  running prompt as a fresh user message with only its own entry id; the daemon absorbs that echo
  into the unacknowledged submitted row it duplicates instead of appending a second row after the
  response, which is what made a sent message appear to slide down the transcript. Submitted rows
  awaiting delivery are marked in the transcript rather than looking already delivered. Key files:
  `packages/server/src/server/agent/{agent-manager,agent-timeline-store}.ts` and
  `packages/app/src/components/message.tsx`.
- A turn started by a Paseo system prompt (subagent finish/error/permission/close notification,
  schedule fire) begins at a visible boundary row. The daemon records the provider's echo of the
  `<paseo-system>` envelope as a `user_message` with `origin: "system"` on live stream, history
  rebuild, and import, instead of dropping it, and absorbs a same-turn re-delivery. System prompts
  have no submitted row, so the echo is the only source. The app renders the row as a divider with
  what triggered the turn and when, body folded until tapped; it starts a turn for folding and page
  alignment and never groups with user bubbles. Titles, the prompt outline, submitted-prompt
  lookups, `get_agent_activity`, fork chat history, and `lastUserMessageAt` skip system rows, and
  the agent still receives the same prompt text. Sessions recorded before this have no such rows.
  Key files: `packages/server/src/server/agent/{agent-prompt,agent-manager,activity-curator}.ts`
  and `packages/app/src/agent-stream/system-notification{,-row}.ts{,x}`.
- A page of older history that fails to load is remembered by its cursor. Returning to the history
  start does not silently re-request it; the history-start slot offers an explicit Retry instead,
  and the block clears as soon as the start cursor moves or a retry succeeds. Key files:
  `packages/app/src/hooks/use-load-older-agent-history.ts` and
  `packages/app/src/agent-stream/older-history-error-row.tsx`.
- Opening a session folds a long last turn at once. The client folds only turns whose user message
  is on screen, so projected `tail` and `before` pages that would open mid-turn extend back to the
  nearest non-steering user message, at most 400 extra entries; past that cap the page keeps its
  normal size and its leading slice stays open. `after` pages and canonical projection are unchanged.
  The daemon projects from the full timeline whenever the control page cannot reach that
  boundary. Key files: `packages/server/src/server/agent/timeline-projection.ts` and
  `packages/server/src/server/session.ts`.
- Advisor, committee and handoff skills are manual-only in the bundled source. Startup skill
  synchronization must retain `disable-model-invocation: true`; editing installed mirrors is not
  a durable customization.
- Transient catalog startup failures (SQLite lock, connection reset/refused, RPC deadline) get
  one read-triggered recovery after a one-second cooldown. Auth/model errors do not auto-retry;
  healthy catalogs and running agents are not reset.
- Daily retry schedules can use the daemon-local `schedule-retry-policies.json` sidecar:
  `{ "version": 1, "retries": { "bbbbbbbb": { "sourceScheduleId": "aaaaaaaa", "timezone": "Asia/Seoul" } } }`.
  The source must be a daily fixed-time cron. The daemon checks the local calendar day before
  starting a model: successful output, a running/inactive source, a not-yet-due source or an
  already-attempted retry skips execution with a recorded reason. Failed/empty/missed due runs
  permit one retry. Missing sources or malformed policy fail visibly without starting a model.
  Existing schedules without a policy keep their behavior; this is not a workflow engine.

## Upstream adoption policy

The last full upstream merge was 2026-08-16 (`4748aad10`). Daseo's timeline, replica cache,
Explorer, mobile keyboard/composer, and popup ownership have since diverged on purpose, so a
whole-branch merge is no longer possible without discarding fork deltas. Judge each upstream
commit by, in order: does it fix a problem Daseo actually has; has Daseo already solved it its
own way; is the root cause the same, not just the symptom; does it keep Daseo's current
workspace, browser, composer, and model-selection behavior; can the needed part be taken
without dragging in a new platform. Prefer `git cherry-pick -x` when the commit applies; hand-port
with the upstream hash in the commit body when it does not. Never resolve a conflict by taking
upstream wholesale.

Adopted since the last merge (upstream PR → Daseo commit subject):

- #4208 disable repository `core.fsmonitor` in daemon git commands (cherry-pick).
- #3909 forward-compatible `desktop-settings.json` (cherry-pick).
- #4283 reject pending Codex app-server requests on dispose (cherry-pick).
- #4068 stop reporting new agent work as "reopened" (cherry-pick).
- #4008 Pi RPC deadline 30s → 60s, `params.rpcTimeoutMs`, phase-attributed timeout errors
  (hand-port, Pi + JSONL transport only; OMP part not carried).
- 11e76f665 resume agents cleanly after a failed turn (hand-port).
- #4332 preserve unchanged provider registry/client/catalog state across config reloads
  (hand-port without plugin providers).
- #4170 completion timestamps for turns without a visible prompt (hand-port adapted to
  Daseo's user-message turn boundaries).
- #4228 react-native-unistyles web registry leak patch (patch + postinstall entry only).
- #4066 readable Paseo tool-call details (cherry-pick; real-Codex e2e not carried).
- #4032, #4049, #4064, #4161 zoomable image previews, Android lightbox gestures, gesture
  stabilization, Escape-first overlay dismissal (cherry-picks; Daseo-local
  `components/ui/icon-button-chrome.ts` provides the small toolbar chrome).
- #4107 fullscreen Mermaid viewer on web (cherry-pick).
- #4048 keep daemon alive when JSONL RPC stdin hits EPIPE (cherry-pick).
- #4742 keep incomplete Markdown formatted while streaming (hand-port; Daseo message.tsx keeps
  its collapsed-work structure).

Reviewed and deliberately not adopted: #4353 (reload ordering change targets Codex's exclusive
session writer; Daseo reloads only on user refresh and voice mode), #4190 / 140b0bb71 / #3907
/ #3975 / #4210 / #4033 (assume upstream's timeline, replica-cache, and navigation
architecture), #4044 / #4051 / #4090 / #4275 (overlap delta 18's native composer replacement
and need device QA), #3411 and #4277 (depend on the plugin timeline/tool platform), #4166
(32k-character answer cap conflicts with delta 5), #3826 Explorer pane host, #4214 tab
tooltips, #3945 / #3825 / #4025 GitHub polling changes (no observed rate-limit pressure).

Reviewed for 0.5.31 and deliberately not adopted:

- #5040 (Daseo resumes only opened chats already — daemon log shows 2 of 481 persisted agents
  resumed at start).
- #3849 (Daseo settles autonomous Pi turns its own way, 0.5.28–0.5.30).
- #4413 (roster pins supported thinking levels; Daseo derives options from thinkingLevelMap).
- #4444 (Daseo never disabled reconnect while backgrounded).
- #4838 / #4863 / #5079 / #5189 / #5013 / #4765 (assume upstream timeline, replica-cache, and
  subscription architecture; no observed Daseo symptom).
- #4676 (adds a native C++ Expo module — new platform).
- #5007 (Electron main RSS 276 MB on a 24 GB host with 54 % free; 38-file entrypoint split not
  worth the port).
- #4442 / #4844 / #4839 / #4895 / #4926 / #4737 (creation, layout, catalog, and older-host paths
  Daseo replaced in deltas 7 and 9; no observed symptom).
- #4646 (overlaps delta 1's hidden-pane unsubscribe). Revisited and adopted for 0.5.43, below.
- #4824 / #4902 / #4946 / #4845 / #4958 / #4927 (composer and voice paths overlap delta 18/native
  composer).
- #4596 / #4470 / #4575 (213-/31-/195-file architecture changes).

Adopted for 0.5.32 (upstream 0.9.1–0.9.2 plus 2026-09-25 main, reviewed 2026-09-25):

- #5190 cheaper Add Project directory scan, #5383 Pi rewind after an earlier rewind, #5322 reject
  missing/non-directory paths from agent-created local workspaces, #5388 OSC 8 terminal links,
  #5341 weekday-last-week dates, #5281 voice thinking tone between reply segments, #5227 keep
  workspaces on an unmounted disk, #5245 Android Back closes a bottom sheet, #5320 multi-select
  question answers, #5272 / #5287 multi-step and rebound shortcuts (clean cherry-picks).
- #5301 invalid schedule file no longer blocks daemon start (cherry-pick; constructor conflict
  with the retry-policy `paseoHome` field resolved by keeping both).
- #5170 degraded Git polling backs off 5s → 60s while a repository is unchanged (hand-resolved:
  only the backoff; the watcher constants and `recovery.establishedAt` that belong to c3e1e084a
  were dropped in a follow-up commit).
- #5332 background daemon start names its failure cause (cherry-pick without the CLI lifecycle
  e2e test Daseo does not carry).
- #5224 modified Backspace as a custom shortcut (source only; Daseo's desktop e2e spec kept).
- #5317 chat uploads keep Korean/CJK and parenthesized file names, capped at 255 bytes
  (hand-resolved alongside Daseo's `upload_<requestId>` directory ids).

Reviewed for 0.5.32 and deliberately not adopted:

- c3e1e084a (bound watcher work for late ignored directories): Daseo's `native-recursive.ts`
  lacks three intermediate upstream commits, and 4 of the 58 upstream tests fail on the port.
- 9978988e3 (heap growth after sessions close): `session/owned-subscriptions` does not exist in
  Daseo (it came with the rejected independent-subscription work).
- #5306 / #5277 (empty or recycled `paseo.pid`): Daseo's pid-lock already reclaims through
  heartbeat freshness and treats an unreadable file as no lock.
- #5315 / #5337 (config.json BOM and error naming): depend on `readPersistedConfig` from the
  rejected #4575; Daseo writes its own config.json.
- #5235 (Stop settles an exited Pi runtime): Pi `cli-runtime`/`jsonl-rpc-process` diverged for
  delta 12 steering; no observed symptom.
- #5343 (delta 20 already starts on Pi's runtime default), #5372 (delta 16 owns updates),
  #5168 / #5286 / #5290 (timeline and replica-cache architecture), #5255 (525-line shortcut hook
  rewrite around a file Daseo lacks), #5205 (test-infra heavy; no trailing-space project names),
  #5146 / #5129 / #5167 (chat Find depends on the rejected #4765).
- Claude, Codex, OMP, OpenCode, Cursor, ACP, plugin, Hub, sponsor, CLI-message, and store-build
  items (#5200 #5285 #5289 #5240 #5206 #5326 #5273 #5239 #5274 #5296 #5338 #3628 #3258 #5243
  #5248 #5253 #5231 #5298 #5302 #5219 #5297 #5258 #5358 #5310 #5335 #5305 #5347 #5174 #5249
  #5221 #5238 #5229 #5374 e3c853df5): paths Daseo does not use.

Adopted for 0.5.57 (reviewed 2026-10-21, 395 upstream commits since 2026-10-04):

- #6334 (`0fc6bf0c9`) and #6532 (`ee0d901ef`), hand-ported around Daseo's retry-policy skip and
  delta 44: a scheduled slot is claimed and its cursor advanced in one serialized store update,
  and the in-memory running mark is cleared even when the run record cannot be written. On
  2026-10-17 two overlapping ticks after a 4-hour daemon stall ran the weekly memory curator's
  slot twice (22:13:56Z and 22:13:57Z) and each finish advanced `nextRunAt`, so the 2026-10-25
  run was skipped (repaired by hand the same night). Upstream's tests came along; five of them
  fail on 0.5.56.

Reviewed for 0.5.57 and deliberately not adopted: #7528 (detached-creation finish notice; Daseo
agents are created parented), #7535 (CLI archive past 200 agents; about 17 live), #7546 (already
delta 45), #7561 (in-memory batched delivery that an abrupt crash can lose, overlaps delta 5),
#7573 (stale running status after restart; delta 44 recovers turns, no incident recorded),
#7532 and #7369 (no Daseo symptom reproduced), #7256 and #6316 (timeline paths Daseo replaced),
#6379 and #6373 (creation and agent-message projection overlap deltas 9 and 5).

Adopted for 0.5.43 (reviewed 2026-10-04):

- #4646 (`16d932651`) capture-time frame production and paint wait (hand-port into delta 33:
  `withFrameProduction` holds the tab in the lifecycle instead of toggling background throttling,
  and the two-frame paint wait is capped at one second and never fails the capture). On its own it
  does not help Daseo: an Electron 41 PoC showed a parked 1×1 tab keeps 75 fps with throttling on
  while the window is visible; only freezing stops it.

Reviewed for 0.5.103 (2026-11-10, upstream link fixes after the last adoption). None of them
cherry-picks: each builds on #6520 (href decoding) and the #6973 renderer rewrite, which Daseo
does not take. Hand-ported into delta 90 (commit `6c420edc4`):

- `fa70b215a` #7205: a folder link expands Files down to that folder, hidden ones included
  (`file-explorer/tree.ts` `revealExplorerDirectory`). The listing probe is replaced by the
  daemon's path resolve, which already knows file from folder.
- `06cdc5a0b` #7210 and `a0aeca967` #7233: an authored markdown destination is taken as
  written, bare and extensionless names included, and only inferred text uses the filename
  heuristic. Daseo differs on one case: a destination that reads as a web address
  (`example.com/guides`) opens over https instead of as a file.
- `a8032a150` #7726: a folder outside the workspace shows "outside this workspace" on the phone
  instead of opening Files on an access error. The desktop editor-target part is not carried:
  the Mac app already opens any folder in Finder (delta 56).
- `0e5bcbd9f` #8361: a relative link written against a nested repository falls back to a
  suffix search when the workspace-root path is missing; Daseo runs it for inline code and
  markdown links alike, through the daemon path resolve.

Reviewed for 0.5.103 and deliberately not adopted: `5384abdba` #7229 and `c70a6cfb9` #7538
(folder and document-relative links in the Markdown preview). Daseo's file-pane preview renders
links through the plain Markdown renderer, not the assistant link opener, so neither problem
exists here; carrying them means routing the preview through the opener first.

## Product version policy

- Mac and Android share one Daseo product SemVer. Any shipped platform change advances it.
- Cut versions with `npm run version:all:patch` (or the other version:all scripts), not bare npm
  version. Preparation requires a clean main, validates version-only manifest/lock changes,
  commits explicit release paths and tags the resulting commit; it never stages the whole tree.
- Do not rebuild an unchanged platform only to match a number. Its next real release jumps to the
  current product version.
- Platform build numbers remain independent: Android `versionCode` and macOS `CFBundleVersion`
  increase only when that platform ships.
- `0.4.0-local.23` was the final `local.N` artifact. New releases use ordinary SemVer.

## Build & ship (Mac mini)

- Before either platform build, run `npm run brand:check`; generated DΛ assets must match the
  canonical mark and manifest. Mac: build with `npm run build:desktop -- --publish never --mac --arm64 --dir`, then run
  `node packages/desktop/scripts/daseo-app-package.mjs packages/desktop/release/mac-arm64/Paseo.app <product-version> <mac-build-version> $(git rev-parse HEAD)`
  followed by
  `node packages/desktop/scripts/daseo-code-sign.mjs packages/desktop/release/mac-arm64/Paseo.app`.
  Verify `Contents/Resources/daseo-distribution.json` exists and `app-update.yml` does not before
  signing or activation.
  The signer requires the stable `Daseo Local Code Signing` identity and intentionally refuses an
  ad-hoc fallback. Stage the signed bundle to `~/Applications/Paseo Local Patch.app`, rename only
  the outer installed directory to `/Applications/Daseo.app`. Run the idle-gated activation script (its waits call
  `"${DASEO_NODE:-node}" packages/desktop/scripts/daseo-activation-gate.mjs --cli "$NEW_CLI"`, once
  before the smoke test and once with `--settle-seconds 0` right before quitting; delta 44)
  through
  `node packages/desktop/scripts/daseo-activate-once.mjs /absolute/path/to/activate-daseo-<version>.sh`.
  The launcher removes any ambient `FORCE_NOW` inherited through an older Daseo process; pass the
  explicit `--force-now` flag only after immediate restart approval. It detaches one unsupervised
  process so it survives the current daemon stopping and
  exits permanently with the script. Never use `launchctl submit` or `KeepAlive` for activation;
  either one can relaunch a successful finalizer into an endless app/daemon replacement loop.
  Never change `CFBundleName`, `CFBundleExecutable`, helper names, bundle IDs, or the user-data
  path. **The `Paseo Daemon` process survives app swaps — always restart it too** (see
  `~/.paseo/restart-daemon-local5.sh` pattern).
- Android: verify the ignored personal Firebase config exists, use JDK 17 and the Android 36
  SDK (`JAVA_HOME=$(/usr/libexec/java_home -v 17)`,
  `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`), then run
  `npm run build:daseo:android` from the repository root for the Fold arm64 download.
  It first runs `brand:check` and `build:app-deps` from the checkout: Metro bundles the app's
  workspace packages from their gitignored `dist/` and `build/` output, and before 0.5.116 the
  script reused whatever an earlier build had left there, so an APK could embed one source commit
  while bundling package code from an older one (a fresh checkout failed at the JS bundle).
  This carries APP_VARIANT and source commit through both prebuild and Gradle: expo-constants
  regenerates embedded config during Gradle, so setting the variant only for prebuild is unsafe.
  The command checks native and embedded package/version/name, direct FCM, source commit and
  the stable APK signer before accepting the artifact. `npm run test:daseo:release` covers these
  contracts and real repeated skill installation. Artifacts live in
  `~/paseo-builds/`, served at `https://mac.tail29eaf5.ts.net/`; install over Wi-Fi ADB
  (`phone install`) when available.
- The Mac bundle embeds its exact source commit; the release manifest records source commits and
  hashes for both Mac and Android artifacts. When both platforms change together, build both from
  the same commit. Push with the `dgk-dev` GitHub account, then switch `gh` back to `ax-dfcorp`.
  Use `gh auth switch -u dgk-dev` and check `gh api user --jq .login` for API calls as dgk-dev:
  `gh auth token -u dgk-dev` returns ax-dfcorp's token on this Mac (2026-11-13), which is read-only
  on the fork (403 "Must have admin rights" or "You must have push access"). Pushing a commit that
  changes `.github/workflows/` needs the `workflow` scope dgk-dev's token lacks; push that one over
  SSH (`git push git@github.com-dgk-dev:dgk-dev/daseo.git main`).
- GitHub Actions on `dgk-dev/daseo` (enabled 2026-11-13 for the APK workflow): the upstream
  workflows that start by themselves on push, tag, pull request, or release are disabled in the
  repository (`gh workflow disable`, no file change, so cherry-picks of them still apply): Android
  APK Release, CI, Deploy App, Deploy Website, Desktop Release, Docker, Nix Update Hash, Nix, and
  Release Notes Sync. Before that, every main push ran CI and Docker (about 2.9 GB of caches and
  artifacts that day), and the `v0.5.115` tag push ran the release workflows: Release Notes Sync
  created a public "Paseo v0.5.115" GitHub release on the fork. The fork's process uses none of
  them; full test suites run locally per file. Enabled: `Daseo Android APK (PoC)` (manual), and
  the manual-only Deploy Relay and Desktop Rollout. Re-enable one as dgk-dev with
  `gh workflow enable "<name>" -R dgk-dev/daseo`.
