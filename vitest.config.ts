import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic only (layout geometry, grid construction, diff parsing,
// broadcast/pattern matching, fuzzy scoring) — no SolidJS reactivity or Tauri IPC, so we
// run in a plain Node environment without the solid plugin. Component/store behaviour is
// still verified end-to-end against the live stack (see PLAN milestone statuses).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
