# Daseo

**Daseo** (= _Do all, seek eternal only_ · initials **dgk** + Paseo) is David-Daniel Kang's
personal fork of [Paseo](https://github.com/getpaseo/paseo), built and shipped as his own
Mac app and Android APK. Logo: **DΛ**.

This file is the fork's source of truth. When asked to "apply Paseo updates to Daseo",
merge upstream `main` into this branch, keep every delta listed below working, rebuild
each changed platform from the task commit, and update this file if the delta set changes.

## Identity

|              | Paseo (upstream)                 | Daseo (this fork)                                                       |
| ------------ | -------------------------------- | ----------------------------------------------------------------------- |
| Repo         | `getpaseo/paseo`                 | `dgk-dev/daseo`, branch `local/patched-desktop`                         |
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
   protocol validation, canonical projection, replica cache, and rendering; phase-less providers
   retain the legacy final-suffix fallback. Expansion restores the original stream items and order
   losslessly. Claude, Codex/ChatGPT, Grok-through-Pi, OpenCode, and other providers share the same
   UI contract; `blockGroupId` is used when available but never required. Active,
   partial/detached, permission-blocked, failed, and canceled turns stay open, while error and
   failed/canceled tool rows remain visible. Terminal outcomes survive canonical hydration, and
   provider message identity preserves manual expansion across renderer-row changes. The projection
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
    branches. Steering identity survives optimistic UI, canonical echo, cache, history, and
    completed-work folding, with a subtle user-message marker. Key files:
    `packages/server/src/server/agent/{agent-prompt,agent-manager,agent-sdk-types}.ts`,
    `packages/server/src/server/agent/providers/{codex-app-server-agent,claude/agent,pi/agent}.ts`,
    `packages/app/src/composer/`, and `packages/app/src/types/stream.ts`.
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
    focus, and hidden retained overlays neither trap nor restore focus over a newer input. Key files:
    `packages/desktop/src/features/browser-webviews/{popup-targets,focus-policy}.ts`,
    `packages/app/src/desktop/browser/{popup-targets,remote-popup-targets,focus-policy}.ts`, and
    `packages/desktop/e2e/browser-tabs.e2e.mjs`.

## Product version policy

- Mac and Android share one Daseo product SemVer. Any shipped platform change advances it.
- Do not rebuild an unchanged platform only to match a number. Its next real release jumps to the
  current product version.
- Platform build numbers remain independent: Android `versionCode` and macOS `CFBundleVersion`
  increase only when that platform ships.
- `0.4.0-local.23` was the final `local.N` artifact. New releases use ordinary SemVer.

## Build & ship (Mac mini)

- Before either platform build, run `npm run brand:check`; generated DΛ assets must match the
  canonical mark and manifest. Mac: build with `npm run build:desktop -- --publish never --mac --arm64 --dir`, then run
  `node packages/desktop/scripts/daseo-app-package.mjs packages/desktop/release/mac-arm64/Paseo.app <product-version> <mac-build-version>`
  followed by
  `node packages/desktop/scripts/daseo-code-sign.mjs packages/desktop/release/mac-arm64/Paseo.app`.
  The signer requires the stable `Daseo Local Code Signing` identity and intentionally refuses an
  ad-hoc fallback. Stage the signed bundle to `~/Applications/Paseo Local Patch.app`, rename only
  the outer installed directory to `/Applications/Daseo.app`, and activate via an idle-gated
  launchd watcher. Never change `CFBundleName`, `CFBundleExecutable`, helper names, bundle IDs,
  or the user-data path. **The `Paseo Daemon` process survives app swaps — always restart it too**
  (see `~/.paseo/restart-daemon-local5.sh` pattern).
- Android: verify the ignored personal Firebase config exists, use JDK 17 and the Android 36
  SDK (`JAVA_HOME=$(/usr/libexec/java_home -v 17)`,
  `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`), then run
  `APP_VARIANT=personal npx expo prebuild --platform android --clean` and
  `cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` for the Fold
  download (omit the architecture property to retain a universal fallback). Artifacts live in
  `~/paseo-builds/`, served at `https://mac.tail29eaf5.ts.net/`; install over Wi-Fi ADB
  (`phone install`) when available.
- Every artifact records its own source commit. When both platforms change together, build both
  from the same commit. Push with the `dgk-dev` GitHub account, then switch `gh` back to
  `ax-dfcorp`.
