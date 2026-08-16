import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained document. The MCP Apps resource carries the app as
// inline text, and a strict CSP forbids remote origins — so every byte the
// workspace needs has to be in the file, including any asset that would
// normally become a separate request.
export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: "es2022",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
    outDir: "dist",
    emptyOutDir: true,
  },
});
