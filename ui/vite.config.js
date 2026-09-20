import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { simulatorPlugin } from "./dev-simulator.mjs";

const apiTarget = process.env.HTN26_API_PROXY_TARGET || "http://127.0.0.1:8787";

export default defineConfig({
  // Fixture scripts are hardware-safe by default: only HTN26_SIMULATE=1 starts them.
  plugins: [tailwindcss(), simulatorPlugin({ target: apiTarget })],
  server: {
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "undercooked.ethanzhao.ca"],
    port: 4173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
