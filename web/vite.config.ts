import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI is built next to the compiled server: dist/web-ui, served by src/web/server.ts.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist/web-ui", emptyOutDir: true, sourcemap: false },
});
