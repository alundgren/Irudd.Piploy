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

// Self-update (#8, #29, #95) compares a release's `tag_name` against this
// constant verbatim. Release builds provide their normalized tag explicitly,
// so manually-dispatched releases do not need to create a tag before building.
// Tagged local builds retain the same behavior without an explicit override.
const gitCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();
const version =
  process.env.PIPLOY_RELEASE_TAG ??
  releaseTagAtHead() ??
  `${packageJson.version}+${gitCommit}`;

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
  noExternal: [
    /^(commander|dockerode|isomorphic-git|pino|zod)(\/.*)?$/,
    // The MCP SDK reaches ajv through its JSON Schema validation, and ajv
    // requires its runtime helpers by subpath.
    /^(@modelcontextprotocol\/sdk|ajv|ajv-formats)(\/.*)?$/,
  ],
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
