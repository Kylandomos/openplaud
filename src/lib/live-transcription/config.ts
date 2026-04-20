import type {
    LiveError,
    LiveProviderCapabilities,
    LiveSessionConfig,
} from "@/types/live-transcription";
import { env } from "@/lib/env";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

const DEFAULT_MODEL = "small";
const DEFAULT_MAX_CHUNK_BYTES = 256 * 1024;
const DEFAULT_EVENT_BUFFER_SIZE = 200;
const DEFAULT_SESSION_RETENTION_MINUTES = 30;

export interface LiveRuntimeEnvironment {
    liveTranscriptionEnabled: boolean;
    whisperLiveEnabled: boolean;
    whisperLiveWsUrl: string;
    defaultLanguage: string | null;
    defaultModel: string;
    defaultTask: LiveSessionConfig["task"];
    defaultUseVad: boolean;
    maxSessionMinutes: number;
    maxChunkBytes: number;
    eventBufferSize: number;
    sessionRetentionMinutes: number;
    capabilities: LiveProviderCapabilities;
}

function parseBoolean(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (!raw) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    return fallback;
}

function parsePositiveInteger(
    name: string,
    fallback: number,
    maxValue: number,
): number {
    const raw = process.env[name];
    if (!raw) return fallback;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, maxValue);
}

function normalizeTask(raw: string | undefined): LiveSessionConfig["task"] {
    if (raw === "translate") return "translate";
    return "transcribe";
}

function normalizeLanguage(raw: string | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toLowerCase() === "auto") return null;
    return trimmed;
}

function normalizeWhisperLiveWsUrl(raw: string): string {
    const parsed = new URL(raw);

    if (parsed.protocol === "http:") {
        parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
        parsed.protocol = "wss:";
    }

    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new Error(
            "WHISPERLIVE_URL must use ws://, wss://, http://, or https://",
        );
    }

    return parsed.toString();
}

export function getLiveRuntimeEnvironment(): LiveRuntimeEnvironment {
    const liveTranscriptionEnabled = env.LIVE_TRANSCRIPTION_ENABLED;
    const whisperLiveEnabled = env.WHISPERLIVE_ENABLED;

    const rawWhisperLiveUrl = env.WHISPERLIVE_URL;
    const whisperLiveWsUrl = rawWhisperLiveUrl
        ? normalizeWhisperLiveWsUrl(rawWhisperLiveUrl)
        : "";

    const legacyLanguage = normalizeLanguage(process.env.WHISPERLIVE_LANGUAGE);
    const defaultLanguage =
        normalizeLanguage(env.LIVE_TRANSCRIPTION_DEFAULT_LANGUAGE) ??
        legacyLanguage;
    const defaultModel =
        env.LIVE_TRANSCRIPTION_DEFAULT_MODEL?.trim() ||
        process.env.WHISPERLIVE_MODEL?.trim() ||
        DEFAULT_MODEL;
    const defaultTask = normalizeTask(process.env.WHISPERLIVE_TASK?.trim());
    const defaultUseVad = parseBoolean("WHISPERLIVE_USE_VAD", true);

    const maxSessionMinutes = Math.max(
        1,
        Math.min(env.LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES, 24 * 60),
    );
    const maxChunkBytes = parsePositiveInteger(
        "LIVE_TRANSCRIPTION_MAX_CHUNK_BYTES",
        DEFAULT_MAX_CHUNK_BYTES,
        4 * 1024 * 1024,
    );
    const eventBufferSize = parsePositiveInteger(
        "LIVE_TRANSCRIPTION_EVENT_BUFFER_SIZE",
        DEFAULT_EVENT_BUFFER_SIZE,
        2000,
    );
    const sessionRetentionMinutes = parsePositiveInteger(
        "LIVE_TRANSCRIPTION_SESSION_RETENTION_MINUTES",
        DEFAULT_SESSION_RETENTION_MINUTES,
        24 * 60,
    );

    return {
        liveTranscriptionEnabled,
        whisperLiveEnabled,
        whisperLiveWsUrl,
        defaultLanguage,
        defaultModel,
        defaultTask,
        defaultUseVad,
        maxSessionMinutes,
        maxChunkBytes,
        eventBufferSize,
        sessionRetentionMinutes,
        capabilities: {
            provider: "whisperlive",
            transport: "relay",
            supportsLanguage: true,
            supportsTask: true,
            supportsVad: true,
            inputSampleRate: 16000,
            inputChannels: 1,
            inputEncoding: "float32-pcm",
        },
    };
}

export function getFeatureDisabledError(): LiveError | null {
    const config = getLiveRuntimeEnvironment();
    if (config.liveTranscriptionEnabled && config.whisperLiveEnabled) {
        return null;
    }

    return {
        code: "feature-disabled",
        message:
            "Live transcription relay is disabled. Enable LIVE_TRANSCRIPTION_ENABLED and WHISPERLIVE_ENABLED.",
        retryable: false,
        details: {
            liveTranscriptionEnabled: config.liveTranscriptionEnabled,
            whisperLiveEnabled: config.whisperLiveEnabled,
        },
    };
}
