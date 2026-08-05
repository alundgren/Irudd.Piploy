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
const optionalTransportDependencyStubPath = fileURLToPath(
  new URL("./src/optionalTransportDependencyStub.cjs", import.meta.url),
);

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
  // Piploy ships only this bundle. Keep every runtime dependency in it rather
  // than relying on a node_modules directory beside the deployed artifact.
  noExternal: [/^(commander|dockerode|isomorphic-git|pino|zod)(\/.*)?$/],
  esbuildPlugins: [
    {
      name: "stub-unreachable-docker-ssh-transport",
      setup(build) {
        // docker-modem eagerly loads ssh2 and cpu-features even though Piploy
        // connects only through Docker's local Unix socket. These native
        // optional dependencies are intentionally unavailable on the Pi.
        build.onResolve({ filter: /^(ssh2|cpu-features)$/ }, () => ({
          path: optionalTransportDependencyStubPath,
        }));
      },
    },
  ],
  define: {
    __PIPLOY_VERSION__: JSON.stringify(version),
  },
  outExtension: () => ({ js: ".cjs" }),
});
