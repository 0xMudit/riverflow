import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const root = process.cwd();

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(root, "src/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(root, "src/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: { "@": resolve(root, "src") },
    },
    build: {
      rollupOptions: { input: resolve(root, "src/renderer/index.html") },
    },
  },
});
