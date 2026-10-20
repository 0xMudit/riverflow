import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The renderer as a plain web page, for reviewing the interface without
 * Electron. It runs against src/renderer/mock.ts, never a real ledger.
 */
export default defineConfig({
  root: resolve(process.cwd(), "src/renderer"),
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(process.cwd(), "src") },
  },
  server: { port: 5199, strictPort: true },
});
