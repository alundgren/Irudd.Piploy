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
const gitCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();
const version = `${packageJson.version}+${gitCommit}`;

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
