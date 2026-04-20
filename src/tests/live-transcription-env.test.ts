import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
    for (const key of Object.keys(process.env)) {
        delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/openplaud";
    process.env.BETTER_AUTH_SECRET =
        "12345678901234567890123456789012";
    process.env.APP_URL = "http://localhost:3000";
    process.env.ENCRYPTION_KEY =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}

describe("Live Transcription Env Parsing", () => {
    beforeEach(() => {
        vi.resetModules();
        resetEnv();
    });

    it("parses booleans, URL normalization, defaults, and integer clamps", async () => {
        process.env.LIVE_TRANSCRIPTION_ENABLED = "yes";
        process.env.WHISPERLIVE_ENABLED = "true";
        process.env.WHISPERLIVE_URL = "https://whisper.example.com/stream";
        process.env.WHISPERLIVE_LANGUAGE = " auto ";
        process.env.WHISPERLIVE_TASK = "translate";
        process.env.WHISPERLIVE_USE_VAD = "0";
        process.env.LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES = "5000";
        process.env.LIVE_TRANSCRIPTION_MAX_CHUNK_BYTES = "99999999";
        process.env.LIVE_TRANSCRIPTION_EVENT_BUFFER_SIZE = "5000";
        process.env.LIVE_TRANSCRIPTION_SESSION_RETENTION_MINUTES = "9999";

        const { getLiveRuntimeEnvironment } = await import(
            "@/lib/live-transcription/config"
        );

        const runtime = getLiveRuntimeEnvironment();

        expect(runtime.liveTranscriptionEnabled).toBe(true);
        expect(runtime.whisperLiveEnabled).toBe(true);
        expect(runtime.whisperLiveWsUrl).toBe(
            "wss://whisper.example.com/stream",
        );
        expect(runtime.defaultLanguage).toBeNull();
        expect(runtime.defaultTask).toBe("translate");
        expect(runtime.defaultUseVad).toBe(false);
        expect(runtime.maxSessionMinutes).toBe(24 * 60);
        expect(runtime.maxChunkBytes).toBe(4 * 1024 * 1024);
        expect(runtime.eventBufferSize).toBe(2000);
        expect(runtime.sessionRetentionMinutes).toBe(24 * 60);
    });

    it("rejects unsupported websocket URL protocols", async () => {
        process.env.WHISPERLIVE_URL = "ftp://example.com/stream";

        const { getLiveRuntimeEnvironment } = await import(
            "@/lib/live-transcription/config"
        );

        expect(() => getLiveRuntimeEnvironment()).toThrow(
            "WHISPERLIVE_URL must use ws://, wss://, http://, or https://",
        );
    });

    it("returns detailed feature-disabled error when either flag is off", async () => {
        process.env.LIVE_TRANSCRIPTION_ENABLED = "false";
        process.env.WHISPERLIVE_ENABLED = "true";

        const { getFeatureDisabledError } = await import(
            "@/lib/live-transcription/config"
        );

        expect(getFeatureDisabledError()).toEqual({
            code: "feature-disabled",
            message:
                "Live transcription relay is disabled. Enable LIVE_TRANSCRIPTION_ENABLED and WHISPERLIVE_ENABLED.",
            retryable: false,
            details: {
                liveTranscriptionEnabled: false,
                whisperLiveEnabled: true,
            },
        });
    });

    it("returns null feature-disabled error when both flags are enabled", async () => {
        process.env.LIVE_TRANSCRIPTION_ENABLED = "1";
        process.env.WHISPERLIVE_ENABLED = "on";
        process.env.WHISPERLIVE_URL = "http://whisperlive:9090";

        const { getFeatureDisabledError } = await import(
            "@/lib/live-transcription/config"
        );

        expect(getFeatureDisabledError()).toBeNull();
    });
});
