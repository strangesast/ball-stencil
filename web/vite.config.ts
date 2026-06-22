import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2021",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
  },
});
