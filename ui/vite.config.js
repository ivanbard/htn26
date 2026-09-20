import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "undercooked.ethanzhao.ca"],
    port: 4173,
  },
});
