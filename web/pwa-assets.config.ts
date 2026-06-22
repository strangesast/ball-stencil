import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// Generates the full PWA icon set from a single source SVG into web/public/.
// Run with:  npx pwa-assets-generator
// Outputs: favicon.ico, pwa-64/192/512, maskable-icon-512, apple-touch-icon-180.
export default defineConfig({
  preset: minimal2023Preset,
  images: ["public/icon.svg"],
});
