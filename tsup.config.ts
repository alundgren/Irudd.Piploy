import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const packageJsonPath = fileURLToPath(
  new URL("./package.json", import.meta.url),
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version: string;
};

function releaseTagAtHead(): string | undefined {
  try {
    return execFileSync("git", ["describe", "--tags", "--exact-match"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

// Self-update (#8, #29) compares a release's `tag_name` against this constant
// verbatim, so a build made at a tagged commit must carry the tag itself —
// not the package version — or every poll would see a spurious update.
const gitCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();
const version = releaseTagAtHead() ?? `${packageJson.version}+${gitCommit}`;

export default defineConfig({
  entry: { piploy: "src/cli.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  outDir: "dist",
  clean: true,
  define: {
    __PIPLOY_VERSION__: JSON.stringify(version),
  },
  outExtension: () => ({ js: ".cjs" }),
});
