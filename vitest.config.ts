import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["protocol/test/**/*.test.ts", "hub/test/**/*.test.ts", "client/test/**/*.test.ts", "relay/test/**/*.test.ts"],
  },
});
