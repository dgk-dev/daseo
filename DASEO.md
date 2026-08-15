# Daseo

**Daseo** (= _Do all, seek eternal only_ · initials **dgk** + Paseo) is David-Daniel Kang's
personal fork of [Paseo](https://github.com/getpaseo/paseo), built and shipped as his own
Mac app and Android APK. Logo: **DΛ**.

This file is the fork's source of truth. When asked to "apply Paseo updates to Daseo",
merge upstream `main` into this branch, keep every delta listed below working, rebuild
both artifacts from the same commit, and update this file if the delta set changes.

## Identity

|              | Paseo (upstream)                 | Daseo (this fork)                                                             |
| ------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| Repo         | `getpaseo/paseo`                 | `dgk-dev/daseo`, branch `local/patched-desktop`                               |
| Mac app      | Paseo.app (App Store / releases) | `/Applications/Daseo.app`, ad-hoc signed local build, version `0.4.0-local.N` |
| Android      | `sh.paseo` (Play)                | `sh.paseo.dgk` ("Daseo"), sideloaded APK, parallel-installable                |
| Display name | Paseo                            | Daseo (display only)                                                          |

**Deliberately unchanged** to stay upstream-compatible and preserve state: internal
identifiers (`productName`, Electron userData path, `~/.paseo`, `paseo` CLI, Mac bundle IDs,
URL scheme `paseo://`), all i18n strings, and the design-system structure. The Android
personal variant is the deliberate exception: it uses `sh.paseo.dgk` for parallel install.

## Fork deltas (must survive upstream merges)

1. **Remote browser streaming to mobile** — daemon `BrowserStreamHub` fans CDP screencast
   frames (binary opcode `0x20`) from the Electron browser host to mobile watchers over the
   relay; tap/scroll/text/key/navigate inputs map back through trusted CDP. Feature flag
   `serverInfo.features.browserRemoteStream`. Key files:
   `packages/protocol/src/binary-frames/browser-stream.ts`,
   `packages/server/src/server/browser-tools/stream-hub.ts`,
   `packages/desktop/src/features/browser-automation/{screencast,stream-input}.ts`,
   `packages/app/src/desktop/browser/pane/index.tsx` (native viewer).
2. **Bidirectional browser workspace sync** — `browser.remote.open/list/close` RPCs let
   phones open real desktop tabs, continuously discover tabs created by Mac UI or agent
   browser tools, refresh URL/title/navigation/loading state, and close the authoritative
   Mac tab. Mobile viewers reconcile from the Mac SSOT on focus and every two seconds;
   transient disconnects preserve local viewers. Workspace header ⋯ menu, tabs-row ∨ menu,
   and pinned globe launcher expose `New browser` when the feature flag is on. Key files:
   `packages/app/src/screens/workspace/workspace-screen.tsx` and
   `packages/app/src/desktop/browser/remote-tabs-sync.ts`.
3. **Rebranding (display-only)** — DΛ icons (`packages/app/assets/images/*`,
   `packages/desktop/assets/*`), Android personal variant name "Daseo"
   (`packages/app/app.config.js`), Mac window-title display name
   (`packages/desktop/src/main.ts`), safe post-build Info.plist patch via
   `packages/desktop/scripts/daseo-app-package.mjs`, and outer `Daseo.app` rename.
   The patch keeps `CFBundleName=Paseo`; Electron uses that internal product name
   to locate the unchanged `Paseo Helper.app` bundles.
4. **Daseo theme** — monotone graphite dark variant registered in
   `packages/app/src/styles/theme.ts` (`darkDaseoTheme`) and selectable in appearance
   settings on desktop and mobile.
5. **Codex-style collapsed work history** — completed turns hide tool/thought/todo/activity
   items behind one expandable "Worked for …" row above the final assistant message; the
   live turn still streams full activity. Provider-agnostic (UI-level), including turns
   spanning the settled/live buffer boundary. `packages/app/src/agent-stream/collapsed-work.ts`
   - wiring in `agent-stream/view.tsx` and `collapsed-work-row.tsx`.
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
   headings use token-proportional line heights so Korean and large-font text is not clipped
   (`packages/app/src/styles/markdown-styles.ts`).
9. **Project-scoped empty workspace auto-create** — `/new` launched from a project creates an
   empty local workspace immediately, allowing browser/terminal use before an agent starts;
   global, worktree, unsupported-daemon, and failure paths retain the intro fallback. Key files:
   `packages/app/src/screens/new-workspace-auto-create.ts` and `new-workspace-screen.tsx`.
10. **Forward MCP handshake compatibility** — newer Pi builds may advertise a protocol date
    newer than the bundled MCP SDK. A forward-dated `initialize` header is normalized just long
    enough for normal MCP negotiation to select the daemon's latest supported version; unknown
    versions on non-initialize requests remain strict. Key files:
    `packages/server/src/server/agent-mcp-protocol.ts` and `bootstrap.ts`.

## Build & ship (Mac mini)

- Mac: build with `npm run build:desktop -- --publish never --mac --arm64 --dir`, then run
  `node packages/desktop/scripts/daseo-app-package.mjs packages/desktop/release/mac-arm64/Paseo.app <local-version>`.
  Ad-hoc sign the patched bundle, stage it to `~/Applications/Paseo Local Patch.app`, rename
  only the outer installed directory to `/Applications/Daseo.app`, and activate via an
  idle-gated launchd watcher. Never change `CFBundleName`, `CFBundleExecutable`, helper names,
  bundle IDs, or the user-data path. **The `Paseo Daemon` process survives app swaps — always
  restart it too** (see `~/.paseo/restart-daemon-local5.sh` pattern).
- Android: verify the ignored personal Firebase config exists, use JDK 17 and the Android 36
  SDK (`JAVA_HOME=$(/usr/libexec/java_home -v 17)`,
  `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`), then run
  `APP_VARIANT=personal npx expo prebuild --platform android --clean` and
  `cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` for the Fold
  download (omit the architecture property to retain a universal fallback). Artifacts live in
  `~/paseo-builds/`, served at `https://mac.tail29eaf5.ts.net/`; install over Wi-Fi ADB
  (`phone install`) when available.
- Both artifacts must come from the same commit. Push with the `dgk-dev` GitHub account,
  then switch `gh` back to `ax-dfcorp`.
