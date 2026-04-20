import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getSessionRoute } from "@/app/api/live-transcriptions/[id]/route";
import { POST as createSessionRoute } from "@/app/api/live-transcriptions/route";

const {
    mockGetSession,
    mockGetFeatureDisabledError,
    mockCreateSession,
    mockGetCapabilities,
    mockGetSessionSnapshot,
    mockGetSessionDurationMs,
    MockLiveSessionError,
} = vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockGetFeatureDisabledError: vi.fn(),
    mockCreateSession: vi.fn(),
    mockGetCapabilities: vi.fn(),
    mockGetSessionSnapshot: vi.fn(),
    mockGetSessionDurationMs: vi.fn(),
    MockLiveSessionError: class MockLiveSessionError extends Error {
        code: string;
        httpStatus: number;
        details?: Record<string, string | number | boolean | null>;

        constructor(
            code: string,
            message: string,
            httpStatus: number,
            details?: Record<string, string | number | boolean | null>,
        ) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
            this.details = details;
        }
    },
}));

vi.mock("@/lib/auth", () => ({
    auth: {
        api: {
            getSession: mockGetSession,
        },
    },
}));

vi.mock("@/lib/live-transcription/config", () => ({
    getFeatureDisabledError: mockGetFeatureDisabledError,
}));

vi.mock("@/lib/live-transcription/runtime-registry", () => {
    return {
        LiveSessionError: MockLiveSessionError,
        liveRuntimeRegistry: {
            createSession: mockCreateSession,
            getCapabilities: mockGetCapabilities,
            getSessionSnapshot: mockGetSessionSnapshot,
        },
        getSessionDurationMs: mockGetSessionDurationMs,
    };
});

const makeSnapshot = (id: string) => ({
    id,
    status: "ready",
    config: {
        provider: "whisperlive",
        transport: "relay",
        language: null,
        model: "small",
        task: "transcribe",
        useVad: true,
        maxSessionMinutes: 90,
        maxChunkBytes: 1024,
    },
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-20T12:00:00.000Z",
    expiresAt: "2026-04-20T13:30:00.000Z",
    stoppedAt: null,
    finalizedAt: null,
    language: null,
    transcriptText: "",
    transcriptSegments: [],
    audioBytesReceived: 0,
    audioSampleCount: 0,
    recordingId: null,
    transcriptionId: null,
    warning: null,
    error: null,
});

describe("Live Transcription Routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetFeatureDisabledError.mockReturnValue(null);
        mockGetSession.mockResolvedValue({
            user: { id: "user-1" },
        });
        mockCreateSession.mockReturnValue(makeSnapshot("session-1"));
        mockGetCapabilities.mockReturnValue({
            provider: "whisperlive",
            transport: "relay",
        });
        mockGetSessionSnapshot.mockReturnValue(makeSnapshot("session-1"));
        mockGetSessionDurationMs.mockReturnValue(1234);
    });

    it("returns 503 when live-transcription feature is disabled", async () => {
        mockGetFeatureDisabledError.mockReturnValue({
            code: "feature-disabled",
            message: "Live relay disabled",
            details: {
                liveTranscriptionEnabled: false,
                whisperLiveEnabled: false,
            },
        });

        const response = await createSessionRoute(
            new Request("http://localhost/api/live-transcriptions", {
                method: "POST",
                body: JSON.stringify({}),
                headers: { "content-type": "application/json" },
            }),
        );

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
            error: "Live relay disabled",
            code: "feature-disabled",
            details: {
                liveTranscriptionEnabled: false,
                whisperLiveEnabled: false,
            },
        });
    });

    it("returns 401 when user is unauthenticated", async () => {
        mockGetSession.mockResolvedValue(null);

        const response = await createSessionRoute(
            new Request("http://localhost/api/live-transcriptions", {
                method: "POST",
                body: JSON.stringify({}),
                headers: { "content-type": "application/json" },
            }),
        );

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
            error: "Unauthorized",
        });
    });

    it("creates a session and returns capabilities for authenticated users", async () => {
        const response = await createSessionRoute(
            new Request("http://localhost/api/live-transcriptions", {
                method: "POST",
                body: JSON.stringify({
                    language: "en",
                    model: "small",
                    task: "transcribe",
                    useVad: true,
                }),
                headers: { "content-type": "application/json" },
            }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            id: "session-1",
            sessionId: "session-1",
            eventsUrl: "/api/live-transcriptions/session-1/events",
            session: makeSnapshot("session-1"),
            capabilities: {
                provider: "whisperlive",
                transport: "relay",
            },
        });
        expect(mockCreateSession).toHaveBeenCalledWith("user-1", {
            language: "en",
            model: "small",
            task: "transcribe",
            useVad: true,
        });
    });

});
