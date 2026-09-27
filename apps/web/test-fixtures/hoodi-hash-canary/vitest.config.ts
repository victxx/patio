import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test-fixtures/hoodi-hash-canary/*.test.ts"] },
});
