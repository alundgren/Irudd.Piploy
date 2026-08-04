import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __PIPLOY_VERSION__: JSON.stringify("test"),
  },
  test: {
    include: ["test/unit/**/*.test.ts"],
    exclude: ["test/integration/**"],
  },
});
