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
   Feature flag `serverInfo.features.browserRemoteStream`. Key files:
   `packages/protocol/src/binary-frames/browser-stream.ts`,
   `packages/server/src/server/browser-tools/stream-hub.ts`,
   `packages/desktop/src/features/browser-automation/{screencast,stream-input}.ts`,
   `packages/app/src/desktop/browser/pane/index.tsx` and `remote-stream-retry.ts` (native viewer).
2. **Bidirectional browser workspace sync** — `browser.remote.open/list/close` RPCs let
   phones open real desktop tabs, continuously discover tabs created by Mac UI or agent
   browser tools, refresh URL/title/navigation/loading state, and close the authoritative
   Mac tab. The desktop workspace layout—not only currently mounted webviews—is the tab-list
   SSOT; listing materializes every persisted browser guest without parking the visible guest.
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
   a matching square Composer with a compact monochrome stop control in `packages/app/src/composer/`
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
   never hides more of the answer than it leaves visible: a folded assistant message that is
   substantive on its own and longer than everything still on screen is revealed. That guard exists
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
    targets stay in non-focusable native parking windows with paintable viewports; users see them
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
    10 minutes. Key files: the `packages/desktop/src/features/browser-automation/` modules
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
    - The browser profile session (`persist:paseo-browser`, used by browser webviews and popups)
      sends a plain Chrome user agent: the `Paseo/<version>` and `Electron/<version>` tokens are
      removed, the Chrome version stays, and Paseo's own renderer keeps Electron's default. It is
      set right after `app.whenReady()` because existing WebContents keep the old value. Key
      files: `packages/desktop/src/features/browser-profile.ts` and `packages/desktop/src/main.ts`.
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
    the tab keeps the latest 500. Request headers drop the ones the browser sets itself;
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
    `backgroundWaits.pending > 0` and no permission, error, or unread attention as `running`
    (`isAgentWaitingInBackground`), so sidebar, tabs, workspace status, the subagent track, the
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
- #4646 (overlaps delta 1's hidden-pane unsubscribe).
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
  the outer installed directory to `/Applications/Daseo.app`. Run the idle-gated activation script
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
