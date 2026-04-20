import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.E2E_APP_PORT ?? "3100");

export default defineConfig({
    testDir: "./src/tests/e2e",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    timeout: 90_000,
    expect: {
        timeout: 20_000,
    },
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI
        ? [["github"], ["html", { open: "never" }]]
        : [["list"], ["html", { open: "never" }]],
    globalSetup: "./src/tests/e2e/support/global-setup.ts",
    use: {
        baseURL: `http://127.0.0.1:${appPort}`,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        permissions: ["microphone", "clipboard-read", "clipboard-write"],
        launchOptions: {
            args: [
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
            ],
        },
    },
    webServer: {
        command: "node ./src/tests/e2e/support/start-e2e-app.mjs",
        url: `http://127.0.0.1:${appPort}/login`,
        timeout: 180_000,
        reuseExistingServer: false,
        stdout: "pipe",
        stderr: "pipe",
    },
    projects: [
        {
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],
            },
        },
    ],
});
