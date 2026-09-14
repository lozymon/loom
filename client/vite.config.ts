import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/** The dev client proxies the WebSocket to a hub on its default port (7420). */
const hubPort = process.env.LOOM_HUB_PORT ?? "7420";

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${hubPort}`, ws: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
