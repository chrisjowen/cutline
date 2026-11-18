import { defineConfig } from "vite";

// The UI is built into dist/ui and served by the cutline server, so every
// request goes through the server's token, Host and Origin checks.
export default defineConfig({
  root: "src/ui",
  base: "/",
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
  },
});
