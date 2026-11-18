import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "packages/app");
const require = createRequire(import.meta.url);
const { getNativeReleaseVersion } = require("../packages/app/native-release-version.js");
const CERTIFICATE = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c";
const FORK = "dgk-dev/daseo";
const WORKFLOW = "daseo-android-apk-poc.yml";
// The Gradle build holds 3.5-6.9 GiB of java for about 2 minutes on the 24 GB Mac mini; pressure
// snapshots on 2026-11-14..16 caught it five times. Below this much free memory, or at macOS
// pressure warn (2) or critical (4), the same build runs on the fork's GitHub runner instead
// (13-17 minutes, free). Same signal as the HYM push gate: kern.memorystatus_level is free %.
const FREE_PERCENT_FLOOR = 45;
const PRESSURE_LEVEL_LIMIT = 2;

/**
 * Where this APK build runs. `--local` / `--github` force a route; a non-macOS host (the GitHub
 * runner itself) always builds in place; otherwise the Mac's memory decides. An unreadable
 * memory signal sends the build to GitHub, because the Mac build is the one that can hurt.
 */
export function chooseAndroidBuildRoute({ platform, args, memory }) {
  if (args.includes("--local") && args.includes("--github"))
    throw new Error("Pass either --local or --github, not both");
  if (args.includes("--local")) return { route: "mac", reason: "forced --local" };
  if (args.includes("--github")) return { route: "github", reason: "forced --github" };
  if (platform !== "darwin") return { route: "mac", reason: "not the Mac mini; build in place" };
  const { freePercent, pressureLevel } = memory ?? {};
  if (!Number.isFinite(freePercent) || !Number.isFinite(pressureLevel))
    return { route: "github", reason: "memory signal unreadable" };
  if (pressureLevel >= PRESSURE_LEVEL_LIMIT)
    return { route: "github", reason: `memory pressure level ${pressureLevel}` };
  if (freePercent < FREE_PERCENT_FLOOR)
    return { route: "github", reason: `free memory ${freePercent}% < ${FREE_PERCENT_FLOOR}%` };
  return { route: "mac", reason: "Mac memory has room" };
}

function readMacMemory() {
  try {
    const [free, level] = execFileSync(
      "sysctl",
      ["-n", "kern.memorystatus_level", "kern.memorystatus_vm_pressure_level"],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    return { freePercent: free, pressureLevel: level };
  } catch {
    return {};
  }
}

function verifyApk({ apk, sdk, env, version, commit }) {
  const tools = readdirSync(path.join(sdk, "build-tools"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (!tools) throw new Error("Android build tools missing");
  const tool = (name) => path.join(sdk, "build-tools", tools, name);
  const config = JSON.parse(
    execFileSync("unzip", ["-p", apk, "assets/app.config"], { encoding: "utf8" }),
  );
  const native = execFileSync(tool("aapt"), ["dump", "badging", apk], { encoding: "utf8", env });
  assertAndroidIdentity(config, native, version, commit);
  const signature = execFileSync(tool("apksigner"), ["verify", "--print-certs", apk], {
    encoding: "utf8",
    env,
  });
  if (!signature.includes(`certificate SHA-256 digest: ${CERTIFICATE}`))
    throw new Error("APK signer differs from installed Daseo identity");
}

// Dispatch needs push rights on the fork, which only dgk-dev has; `gh auth token -u dgk-dev`
// returns ax-dfcorp's token on this Mac (2026-11-13), so switch the active account for the one
// dispatch call and switch straight back. Watching and downloading read the public fork as ax-dfcorp.
function dispatchOnFork(commit) {
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
  gh("auth", "switch", "-u", "dgk-dev");
  let out;
  try {
    out = gh("workflow", "run", WORKFLOW, "-R", FORK, "-f", `ref=${commit}`);
  } finally {
    gh("auth", "switch", "-u", "ax-dfcorp");
  }
  const id = out.match(/actions\/runs\/(\d+)/)?.[1];
  if (!id) throw new Error(`Could not read the run id from gh workflow run output: ${out}`);
  return id;
}

function buildOnGitHub({ commit, apk }) {
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
  try {
    gh("api", `repos/${FORK}/commits/${commit}`, "--jq", ".sha");
  } catch {
    throw new Error(`Commit ${commit} is not on ${FORK}; push it to the fork first`);
  }
  const runId = dispatchOnFork(commit);
  console.log(`[build-daseo-android] GitHub run https://github.com/${FORK}/actions/runs/${runId}`);
  execFileSync("gh", ["run", "watch", runId, "-R", FORK, "--exit-status", "-i", "30"], {
    stdio: "inherit",
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "daseo-apk-"));
  try {
    gh("run", "download", runId, "-R", FORK, "-n", `daseo-apk-${commit}`, "-D", dir);
    mkdirSync(path.dirname(apk), { recursive: true });
    copyFileSync(path.join(dir, "app-release.apk"), apk);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return `GitHub Actions run ${runId}`;
}
export function assertAndroidIdentity(config, native, version, commit) {
  const expected = getNativeReleaseVersion(version);
  if (
    config.name !== "Daseo" ||
    config.android?.package !== "sh.paseo.dgk" ||
    config.extra?.directFcmPush !== true ||
    config.version !== expected.appVersion ||
    config.android.versionCode !== expected.androidVersionCode ||
    config.extra.daseoSourceCommit !== commit ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    !native.includes(
      `package: name='sh.paseo.dgk' versionCode='${expected.androidVersionCode}' versionName='${expected.appVersion}'`,
    )
  ) {
    throw new Error(
      "Daseo APK native/embedded identity, version, source commit or direct FCM contract mismatch",
    );
  }
}
export function buildAndroid(args = process.argv.slice(2)) {
  const memory = process.platform === "darwin" ? readMacMemory() : {};
  const decision = chooseAndroidBuildRoute({ platform: process.platform, args, memory });
  console.log(
    `[build-daseo-android] execution: ${decision.route} (${decision.reason}; free ${memory.freePercent ?? "?"}%, level ${memory.pressureLevel ?? "?"})`,
  );
  if (args.includes("--dry-run")) return decision;
  const git = (...gitArgs) =>
    execFileSync("git", ["-C", root, ...gitArgs], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain"))
    throw new Error("Build from a committed checkout; do not include concurrent changes");
  const commit = git("rev-parse", "HEAD");
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const apk = path.join(app, "android/app/build/outputs/apk/release/app-release.apk");
  let builtBy;
  if (decision.route === "github") {
    rmSync(apk, { force: true });
    builtBy = buildOnGitHub({ commit, apk });
  }
  if (
    decision.route === "mac" &&
    !existsSync(path.join(app, ".secrets/google-services.personal.json"))
  )
    throw new Error("Personal Firebase config is missing");
  const java =
    process.env.JAVA_HOME ||
    execFileSync("/usr/libexec/java_home", ["-v", "17"], { encoding: "utf8" }).trim();
  const sdk = process.env.ANDROID_HOME || "/opt/homebrew/share/android-commandlinetools";
  const env = {
    ...process.env,
    APP_VARIANT: "personal",
    DASEO_SOURCE_COMMIT: commit,
    JAVA_HOME: java,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
  };
  // Metro bundles the app's workspace packages from their gitignored dist/ and build/ output, so
  // build them from this commit first; otherwise an APK that embeds this commit can carry package
  // code left by an older build (a fresh checkout has none and fails at the JS bundle). The same
  // pre-build step as packages/app's eas-build-post-install, minus build:terminal-webview, whose
  // output is committed.
  if (decision.route === "mac") {
    for (const script of ["brand:check", "build:app-deps"]) {
      execFileSync("npm", ["run", script], { cwd: root, env, stdio: "inherit" });
    }
    execFileSync("npx", ["expo", "prebuild", "--platform", "android", "--clean"], {
      cwd: app,
      env,
      stdio: "inherit",
    });
    // Release builds are hours apart, so a warm Gradle daemon is never reused, yet it and the
    // Kotlin daemon it owns kept about 7 GB resident for up to 3 hours after each build on the
    // 24 GB Mac mini. Stopping Gradle's daemons also stops the Kotlin daemon.
    try {
      execFileSync("./gradlew", ["assembleRelease", "-PreactNativeArchitectures=arm64-v8a"], {
        cwd: path.join(app, "android"),
        env,
        stdio: "inherit",
      });
    } finally {
      execFileSync("./gradlew", ["--stop"], {
        cwd: path.join(app, "android"),
        env,
        stdio: "inherit",
      });
    }
    builtBy = process.env.GITHUB_RUN_ID
      ? `GitHub Actions run ${process.env.GITHUB_RUN_ID}`
      : `${os.hostname()} (local)`;
  }
  verifyApk({ apk, sdk, env, version, commit });
  if (git("rev-parse", "HEAD") !== commit || git("status", "--porcelain"))
    throw new Error("Checkout changed during build; artifact is not releasable");
  console.log(
    JSON.stringify({
      apk,
      version,
      sourceCommit: commit,
      nativeAndEmbeddedIdentity: "verified",
      directFcmPush: true,
      signature: "verified",
      builtBy,
    }),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildAndroid(process.argv.slice(2));
