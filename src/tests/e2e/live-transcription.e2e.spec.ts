import { expect, test } from "@playwright/test";
import { registerThroughUi } from "./support/auth";

test.describe("live transcription browser flow", () => {
    test("captures microphone audio, streams transcript, and recovers after refresh", async ({
        page,
    }) => {
        await registerThroughUi(page);

        await page.goto("/live");
        await expect(
            page.getByRole("heading", { name: "Live Transcription" }),
        ).toBeVisible();

        await page.getByTestId("live-start-button").click();

        await expect(
            page.getByTestId("live-transcript-viewport"),
        ).toContainText("Deterministic transcript from E2E whisper mock.");

        await page.reload();

        await expect(
            page.getByTestId("live-transcript-viewport"),
        ).toContainText("Deterministic transcript from E2E whisper mock.");
        await expect(page.getByTestId("live-status-badge")).toContainText(
            /Recoverable|Listening|Receiving Partial Transcript/,
        );

        const resumeButton = page.getByTestId("live-resume-button");
        if (await resumeButton.isVisible()) {
            await resumeButton.click();
            await expect(
                page.getByText(/Listening|Receiving Partial Transcript/),
            ).toBeVisible();
        }

        if (await page.getByTestId("live-stop-button").isVisible()) {
            await page.getByTestId("live-stop-button").click();
        }
        page.on("dialog", (dialog) => dialog.accept());
        await page.getByTestId("live-discard-button").click();

        await expect(page.getByText("Recent Live Sessions")).toBeVisible();
    });
});
