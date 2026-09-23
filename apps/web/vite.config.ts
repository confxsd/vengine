import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // The dev proxy decides where the app's data lives. By default it points at the
  // deployed worker, so local dev and the site share ONE store (D1+R2) — everything
  // you do locally is reflected at vengine.rome.markets and vice versa. Point
  // VITE_API_TARGET at the local server for a fully offline session.
  const env = loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), "");
  const apiTarget = env.VITE_API_TARGET || "https://vengine.rome.markets";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
        "/ws": { target: apiTarget.replace(/^http/, "ws"), ws: true },
      },
    },
  };
});
