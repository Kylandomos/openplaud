import type { FullConfig } from "@playwright/test";
import { startMockWhisperLiveServer } from "./mock-whisperlive-server";

export default async function globalSetup(_config: FullConfig) {
    const whisperPort = Number(process.env.E2E_WHISPERLIVE_PORT ?? "10090");
    const mockServer = await startMockWhisperLiveServer(whisperPort);

    return async () => {
        await mockServer.close();
    };
}
