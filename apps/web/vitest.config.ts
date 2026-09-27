import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "lib/**/*.{test,spec}.{ts,tsx}",
      "src/**/*.{test,spec}.{ts,tsx}",
      "test-fixtures/nonce-retirement/candidate.test.ts",
      "test-fixtures/nonce-retirement/full-app-metadata.test.ts",
      "test-fixtures/nonce-retirement/peer-readiness.test.ts",
      "test-fixtures/nonce-retirement/demo-radio.test.ts",
      "test-fixtures/hash-receiver/receiver.test.ts",
    ],
    passWithNoTests: true,
  },
});
