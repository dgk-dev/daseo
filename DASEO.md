# Daseo

**Daseo** (= _Do all, seek eternal only_ · initials **dgk** + Paseo) is David-Daniel Kang's
personal fork of [Paseo](https://github.com/getpaseo/paseo), built and shipped as his own
Mac app and Android APK. Logo: **DΛ**.

This file is the fork's source of truth. When asked to "apply Paseo updates to Daseo",
merge upstream `main` into this branch, keep every delta listed below working, rebuild
both artifacts from the same commit, and update this file if the delta set changes.

## Identity

|              | Paseo (upstream)                 | Daseo (this fork)                                                                    |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------ |
| Repo         | `getpaseo/paseo`                 | `dgk-dev/daseo`, branch `local/patched-desktop`                                      |
| Mac app      | Paseo.app (App Store / releases) | `/Applications/Daseo.app`, ad-hoc signed local build, version `0.4.0-beta.2-local.N` |
| Android      | `sh.paseo` (Play)                | `sh.paseo.dgk` ("Daseo"), sideloaded APK, parallel-installable                       |
| Display name | Paseo                            | Daseo (display only)                                                                 |

**Deliberately unchanged** to stay upstream-compatible and preserve state: internal
identifiers (`productName`, Electron userData path, `~/.paseo`, `paseo` CLI, bundle/package
IDs, URL scheme `paseo://`), all i18n strings, and the design-system structure.

## Fork deltas (must survive upstream merges)

1. **Remote browser streaming to mobile** — daemon `BrowserStreamHub` fans CDP screencast
   frames (binary opcode `0x20`) from the Electron browser host to mobile watchers over the
   relay; tap/scroll/text/key/navigate inputs map back through trusted CDP. Feature flag
   `serverInfo.features.browserRemoteStream`. Key files:
   `packages/protocol/src/binary-frames/browser-stream.ts`,
   `packages/server/src/server/browser-tools/stream-hub.ts`,
   `packages/desktop/src/features/browser-automation/{screencast,stream-input}.ts`,
   `packages/app/src/desktop/browser/pane/index.tsx` (native viewer).
2. **Mobile "New browser" entry points** — `browser.remote.open` RPC lets phones open a
   real desktop browser tab and attach the stream viewer; workspace header ⋯ menu and
   tabs-row ∨ menu show the item when the feature flag is on
   (`packages/app/src/screens/workspace/workspace-screen.tsx`).
3. **Rebranding (display-only)** — DΛ icons (`packages/app/assets/images/*`,
   `packages/desktop/assets/*`), Android personal variant name "Daseo"
   (`packages/app/app.config.js`), Mac window-title display name
   (`packages/desktop/src/main.ts`), post-build Info.plist patch + `Daseo.app` rename
   (activation scripts under `~/.paseo/`).
4. **Daseo theme** — monotone graphite dark variant registered in
   `packages/app/src/styles/theme.ts` (`darkDaseoTheme`) and selectable in appearance
   settings on desktop and mobile.
5. **Codex-style collapsed work history** — completed turns hide tool/thought/todo/activity
   items behind the per-turn "Worked for …" footer with an expandable steps chip; the live
   turn still streams full activity. Provider-agnostic (UI-level).
   `packages/app/src/agent-stream/collapsed-work.ts` + wiring in
   `agent-stream/view.tsx`, `turn-footer.tsx`, `components/message.tsx`.
6. **Model/abort robustness patches** — replacement-model catalog probe skip, aborted-turn
   cancellation normalization (`packages/server/src/server/agent/provider-registry.ts`,
   `providers/pi/agent.ts`), send-gate fix and native combobox placement
   (`packages/app/src/provider-selection/provider-selection.ts`,
   `components/ui/combobox.tsx`).

## Build & ship (Mac mini)

- Mac: `npm run build:desktop -- --publish never --mac --arm64 --dir`, patch Info.plist
  version/name, ad-hoc codesign, stage to `~/Applications/Paseo Local Patch.app`, activate
  via idle-gated launchd watcher. **The `Paseo Daemon` process survives app swaps — always
  restart it too** (see `~/.paseo/restart-daemon-local5.sh` pattern).
- Android: `APP_VARIANT=personal npx expo prebuild --platform android` then
  `cd android && ./gradlew assembleRelease`; artifacts in `~/paseo-builds/`, served at
  `https://mac.tail29eaf5.ts.net/`; install over Wi-Fi ADB (`phone install`) when available.
- Both artifacts must come from the same commit. Push with the `dgk-dev` GitHub account,
  then switch `gh` back to `ax-dfcorp`.
