import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { open: true },
  build: {
    // Vite only follows index.html by default; a second page has to be declared
    // or it is silently absent from dist/ while working perfectly in dev.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        about: resolve(import.meta.dirname, "about.html"),
      },
    },
  },
});
