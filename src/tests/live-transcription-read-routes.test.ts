import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getEventsRoute } from "@/app/api/live-transcriptions/[id]/events/route";
import { GET as getSessionRoute } from "@/app/api/live-transcriptions/[id]/route";
import { GET as listSessionsRoute } from "@/app/api/live-transcriptions/route";

const {
    mockGetSession,
    mockGetFeatureDisabledError,
    mockListSessionHistoryForRead,
    mockGetSessionReadStateForRead,
    mockGetSessionDurationMs,
    mockGetSessionEventsForRead,
    mockSubscribe,
    mockCreateSession,
    mockGetCapabilities,
} = vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockGetFeatureDisabledError: vi.fn(),
    mockListSessionHistoryForRead: vi.fn(),
    mockGetSessionReadStateForRead: vi.fn(),
    mockGetSessionDurationMs: vi.fn(),
    mockGetSessionEventsForRead: vi.fn(),
    mockSubscribe: vi.fn(),
    mockCreateSession: vi.fn(),
    mockGetCapabilities: vi.fn(),
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

vi.mock("@/lib/live-transcription/runtime-registry", () => ({
    liveRuntimeRegistry: {
        listSessionHistoryForRead: mockListSessionHistoryForRead,
        getSessionReadStateForRead: mockGetSessionReadStateForRead,
        getSessionEventsForRead: mockGetSessionEventsForRead,
        subscribe: mockSubscribe,
        // route.ts POST references these exports
        createSession: mockCreateSession,
        getCapabilities: mockGetCapabilities,
    },
    getSessionDurationMs: mockGetSessionDurationMs,
}));

function makeSnapshot(id: string) {
    return {
        id,
        status: "streaming" as const,
        config: {
            provider: "whisperlive" as const,
            transport: "relay" as const,
            language: "en",
            model: "small",
            task: "transcribe" as const,
            useVad: true,
            maxSessionMinutes: 90,
            maxChunkBytes: 256 * 1024,
        },
        createdAt: "2026-04-20T12:00:00.000Z",
        updatedAt: "2026-04-20T12:01:00.000Z",
        expiresAt: "2026-04-20T13:30:00.000Z",
        stoppedAt: null,
        finalizedAt: null,
        language: "en",
        transcriptText: "hello world",
        transcriptSegments: [],
        audioBytesReceived: 1024,
        audioSampleCount: 32000,
        recordingId: null,
        transcriptionId: null,
        warning: null,
        error: null,
    };
}

describe("Live Transcription Read Routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetFeatureDisabledError.mockReturnValue(null);
        mockGetSession.mockResolvedValue({
            user: { id: "user-1" },
        });
        mockSubscribe.mockReturnValue(() => {});
        mockGetSessionDurationMs.mockReturnValue(2000);
    });

    it("lists session history with limit clamping, cursor decode, and status filter", async () => {
        const cursorCreatedAt = "2026-04-20T09:00:00.000Z";
        const encodedCursor = Buffer.from(
            JSON.stringify({
                createdAt: cursorCreatedAt,
                id: "cursor-1",
            }),
            "utf8",
        ).toString("base64url");

        mockListSessionHistoryForRead.mockResolvedValue({
            items: [
                {
                    id: "session-1",
                    status: "finalized",
                    createdAt: "2026-04-20T10:00:00.000Z",
                    updatedAt: "2026-04-20T10:05:00.000Z",
                    stoppedAt: "2026-04-20T10:04:00.000Z",
                    finalizedAt: "2026-04-20T10:05:00.000Z",
                    language: "en",
                    model: "small",
                    durationMs: 10000,
                    recordingId: "rec-1",
                    transcriptCharCount: 20,
                    transcriptPreview: "Hello from history",
                },
            ],
            nextCursor: {
                createdAt: "2026-04-20T08:00:00.000Z",
                id: "session-2",
            },
        });

        const response = await listSessionsRoute(
            new Request(
                `http://localhost/api/live-transcriptions?limit=500&status=finalized&cursor=${encodedCursor}`,
            ),
        );

        expect(response.status).toBe(200);
        expect(mockListSessionHistoryForRead).toHaveBeenCalledTimes(1);

        const [, queryArg] = mockListSessionHistoryForRead.mock.calls[0];
        expect(queryArg.limit).toBe(50);
        expect(queryArg.status).toBe("finalized");
        expect(queryArg.cursor).toEqual({
            createdAt: new Date(cursorCreatedAt),
            id: "cursor-1",
        });

        const payload = await response.json();
        expect(payload.items).toHaveLength(1);
        expect(payload.nextCursor).toBe(
            Buffer.from(
                JSON.stringify({
                    createdAt: "2026-04-20T08:00:00.000Z",
                    id: "session-2",
                }),
                "utf8",
            ).toString("base64url"),
        );
    });

    it("returns 400 for invalid history status filter", async () => {
        const response = await listSessionsRoute(
            new Request(
                "http://localhost/api/live-transcriptions?status=unknown-status",
            ),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            error: "Invalid status filter",
            code: "bad-request",
        });
        expect(mockListSessionHistoryForRead).not.toHaveBeenCalled();
    });

    it("returns resume metadata from GET /api/live-transcriptions/[id]", async () => {
        const snapshot = makeSnapshot("session-1");
        mockGetSessionReadStateForRead.mockResolvedValue({
            snapshot,
            isActive: true,
            lastSeq: 17,
        });
        mockGetSessionDurationMs.mockReturnValue(4200);

        const response = await getSessionRoute(
            new Request("http://localhost/api/live-transcriptions/session-1"),
            {
                params: Promise.resolve({ id: "session-1" }),
            },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            session: snapshot,
            durationMs: 4200,
            resume: {
                isActive: true,
                lastSeq: 17,
            },
        });
    });

    it("events route uses query afterSeq and snapshot includes lastSeq", async () => {
        mockGetSessionEventsForRead.mockResolvedValue({
            snapshot: makeSnapshot("session-1"),
            events: [],
            isActive: false,
            lastSeq: 9,
        });

        const response = await getEventsRoute(
            new Request(
                "http://localhost/api/live-transcriptions/session-1/events?afterSeq=7",
                {
                    headers: {
                        "last-event-id": "2",
                    },
                },
            ),
            {
                params: Promise.resolve({ id: "session-1" }),
            },
        );

        expect(response.status).toBe(200);
        expect(mockGetSessionEventsForRead).toHaveBeenCalledWith(
            "session-1",
            "user-1",
            7,
        );
        expect(mockSubscribe).not.toHaveBeenCalled();

        const text = await response.text();
        expect(text).toContain("event: snapshot");
        expect(text).toContain('"lastSeq":9');
    });

    it("events route falls back to Last-Event-ID when query afterSeq is missing", async () => {
        mockGetSessionEventsForRead.mockResolvedValue({
            snapshot: makeSnapshot("session-1"),
            events: [],
            isActive: false,
            lastSeq: 11,
        });

        const response = await getEventsRoute(
            new Request(
                "http://localhost/api/live-transcriptions/session-1/events",
                {
                    headers: {
                        "last-event-id": "11",
                    },
                },
            ),
            {
                params: Promise.resolve({ id: "session-1" }),
            },
        );

        expect(response.status).toBe(200);
        expect(mockGetSessionEventsForRead).toHaveBeenCalledWith(
            "session-1",
            "user-1",
            11,
        );
    });
});
