import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __PIPLOY_VERSION__: JSON.stringify("test"),
  },
  test: {
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
  },
});
