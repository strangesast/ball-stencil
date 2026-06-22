import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

// Use a preinstalled Chromium if present (the sandbox ships one under
// /opt/pw-browsers); otherwise fall back to Playwright's managed download.
const SYSTEM_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 30000 },
  use: {
    baseURL: "http://localhost:4173",
    trace: "off",
    launchOptions: { executablePath, args: ["--no-sandbox"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173",
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
  },
});
