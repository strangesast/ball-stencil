import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative base by default so the build runs anywhere (and local dev / preview
  // / e2e stay rooted at "/"). The GitHub Pages workflow sets VITE_BASE_PATH to
  // the project subpath (e.g. "/ball-stencil/") for an absolute, SW-friendly base.
  base: process.env.VITE_BASE_PATH || "./",
  build: {
    target: "es2021",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  // poly2tri's UMD module references Node's `global` (no-conflict bookkeeping),
  // which is undefined in the browser worker and throws at import time. Map it to
  // globalThis for both the app build (rollup) and the dev pre-bundle (esbuild).
  // (No source file uses a bare `global`, so this define is safe.)
  define: { global: "globalThis" },
  // These run only inside the geometry worker, so Vite discovers them lazily on
  // the first build and then re-optimizes + reloads mid-session (a one-time
  // "building forever" stall in dev). Pre-bundle them at server start instead.
  optimizeDeps: {
    include: ["clipper2-js", "delaunator", "poly2tri", "js-angusj-clipper", "workbox-window"],
    esbuildOptions: { define: { global: "globalThis" } },
  },
  plugins: [
    VitePWA({
      // We author src/sw.ts ourselves; the plugin only injects the precache
      // list (the real, hashed dist/ output — incl. the lazy worker/pipeline
      // chunk that index.html never references) at self.__WB_MANIFEST.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false, // we register via src/pwa.ts (virtual:pwa-register)
      injectManifest: {
        // Precache the whole shell. The lazy ~97 kB pipeline chunk is bigger
        // than the 2 KB-ish default cap implies, but well under this ceiling.
        globPatterns: ["**/*.{js,css,html,ico,png,jpg,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: "ball-stencil — SVG → sphere stencil",
        short_name: "ball-stencil",
        description:
          "Turn a filled SVG into a watertight draw-through hemispherical stencil shell. Runs fully in your browser, offline.",
        theme_color: "#0e1014",
        background_color: "#0e1014",
        display: "standalone",
        orientation: "any",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      // Lets the SW be exercised on the dev server too (does not break HMR).
      devOptions: {
        enabled: true,
        type: "module",
        navigateFallback: "index.html",
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
  },
});
