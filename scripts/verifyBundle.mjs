import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const bundlePath = path.resolve("dist/piploy.cjs");
// ajv is bundled, but it also emits these specifiers as source text into the
// validators it generates for its own consumers. Nothing here requires them.
const generatedSpecifiers = [
  "ajv/dist/runtime/equal",
  "ajv/dist/runtime/ucs2length",
  "ajv/dist/runtime/uri",
  "ajv/dist/runtime/validation_error",
  "ajv-formats/dist/formats",
];
const allowedModules = new Set([
  ...builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
  ...generatedSpecifiers,
]);
const requiredModules = [
  ...readFileSync(bundlePath, "utf8").matchAll(
    /\brequire\((["'])([^"']+)\1\)/g,
  ),
].map((match) => match[2]);
const externalModules = [
  ...new Set(
    requiredModules.filter(
      (moduleName) =>
        moduleName !== undefined && !allowedModules.has(moduleName),
    ),
  ),
];

if (externalModules.length > 0) {
  throw new Error(
    `Bundle has external runtime requires: ${externalModules.join(", ")}`,
  );
}

const temporaryDirectory = mkdtempSync(
  path.join(os.tmpdir(), "piploy-bundle-"),
);

try {
  const deployedBundlePath = path.join(temporaryDirectory, "piploy.cjs");
  cpSync(bundlePath, deployedBundlePath);
  writeFileSync(
    path.join(temporaryDirectory, "piploy.json"),
    JSON.stringify({
      Piploy: {
        RootDirectory: path.join(temporaryDirectory, "root"),
        Applications: [],
      },
    }),
  );

  for (const args of [["--version"], ["status"]]) {
    const result = spawnSync(process.execPath, [deployedBundlePath, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Clean-install check failed for '${args.join(" ")}': ${result.error?.message ?? result.stderr}`,
      );
    }
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
