import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_DASEO_CODESIGN_IDENTITY = "Daseo Local Code Signing";

export function hasCodeSigningIdentity(output, identity) {
  return output.split("\n").some((line) => line.includes(`"${identity}"`));
}

export function assertCodeSigningIdentityAvailable({ output, identity }) {
  if (hasCodeSigningIdentity(output, identity)) return;
  throw new Error(
    `Missing stable code-signing identity "${identity}". Refusing ad-hoc signing because it invalidates macOS privacy grants after every rebuild.`,
  );
}

export function signDaseoMacBundle({
  appPath,
  identity = process.env.DASEO_CODESIGN_IDENTITY ?? DEFAULT_DASEO_CODESIGN_IDENTITY,
}) {
  const identities = execFileSync(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    {
      encoding: "utf8",
    },
  );
  assertCodeSigningIdentityAvailable({ output: identities, identity });

  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--timestamp=none", "--sign", identity, appPath],
    { stdio: "inherit" },
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });

  const requirementResult = spawnSync("/usr/bin/codesign", ["-d", "-r-", appPath], {
    encoding: "utf8",
  });
  if (requirementResult.status !== 0) {
    throw new Error(requirementResult.stderr || "Failed to read Daseo's designated requirement");
  }
  const requirement = `${requirementResult.stdout}${requirementResult.stderr}`;
  if (/designated\s*=>\s*cdhash\b/.test(requirement)) {
    throw new Error("Daseo still has a cdhash-only designated requirement after stable signing");
  }

  return { identity, requirement: requirement.trim() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [appPath, identity] = process.argv.slice(2);
  if (!appPath) {
    throw new Error("Usage: daseo-code-sign.mjs <app-path> [identity]");
  }
  const result = signDaseoMacBundle({ appPath, identity });
  process.stdout.write(`Signed ${appPath} with ${result.identity}\n${result.requirement}\n`);
}
