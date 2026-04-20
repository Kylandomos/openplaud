import { expect, type Page } from "@playwright/test";

export interface TestCredentials {
    name: string;
    email: string;
    password: string;
}

export function makeTestCredentials(): TestCredentials {
    const uniqueId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    return {
        name: "E2E User",
        email: `e2e-live-${uniqueId}@example.com`,
        password: "password-1234",
    };
}

export async function registerThroughUi(page: Page): Promise<TestCredentials> {
    const credentials = makeTestCredentials();

    await page.goto("/register");
    await expect(
        page.getByRole("heading", { name: "Create Account" }),
    ).toBeVisible();

    await page.getByLabel("Name").fill(credentials.name);
    await page.getByLabel("Email").fill(credentials.email);
    await page
        .getByLabel("Password", { exact: true })
        .fill(credentials.password);
    await page.getByLabel("Confirm Password").fill(credentials.password);

    await Promise.all([
        page.waitForURL(/\/(onboarding|dashboard)/),
        page.getByRole("button", { name: "Create Account" }).click(),
    ]);

    return credentials;
}
