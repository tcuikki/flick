import { defineConfig, devices } from "@playwright/test";

const PORT = 8788;
const iPhone = devices["iPhone 15 Pro"];

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 6_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Chromium で iPhone 15 Pro の画面サイズ・タッチ・UA・DPR をエミュレート
    ...iPhone,
    defaultBrowserType: "chromium",
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    serviceWorkers: "block",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "iphone" }],
  webServer: {
    // 本番ビルドを Workers ランタイム (workerd) で配信。CLOUDFLARE_ENV=e2e で AI モック & テストログインを有効化
    command: `rm -rf .wrangler/state/v3/d1 && CLOUDFLARE_ENV=e2e npx vite build && npx wrangler d1 migrations apply flick-db-e2e --local --env e2e && CLOUDFLARE_ENV=e2e npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
