import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    mockCreateWhisperLiveAdapter,
    mockPersistFinalizedLiveSession,
    mockGetLiveRuntimeEnvironment,
    mockPersistLiveSessionState,
    mockPersistLiveSegment,
    mockGetPersistedLiveSessionRecord,
    mockGetPersistedLiveSessionSnapshot,
    mockDeletePersistedLiveSession,
    mockAdapterIsOpen,
    mockAdapterSendChunk,
    mockAdapterClose,
} = vi.hoisted(() => ({
    mockCreateWhisperLiveAdapter: vi.fn(),
    mockPersistFinalizedLiveSession: vi.fn(),
    mockGetLiveRuntimeEnvironment: vi.fn(),
    mockPersistLiveSessionState: vi.fn(),
    mockPersistLiveSegment: vi.fn(),
    mockGetPersistedLiveSessionRecord: vi.fn(),
    mockGetPersistedLiveSessionSnapshot: vi.fn(),
    mockDeletePersistedLiveSession: vi.fn(),
    mockAdapterIsOpen: vi.fn(),
    mockAdapterSendChunk: vi.fn(),
    mockAdapterClose: vi.fn(),
}));

vi.mock("@/lib/live-transcription/whisperlive-adapter", () => ({
    createWhisperLiveAdapter: mockCreateWhisperLiveAdapter,
}));

vi.mock("@/lib/live-transcription/persistence", () => ({
    persistFinalizedLiveSession: mockPersistFinalizedLiveSession,
}));

vi.mock("@/lib/live-transcription/session-store", () => ({
    persistLiveSessionState: mockPersistLiveSessionState,
    persistLiveSegment: mockPersistLiveSegment,
    getPersistedLiveSessionRecord: mockGetPersistedLiveSessionRecord,
    getPersistedLiveSessionSnapshot: mockGetPersistedLiveSessionSnapshot,
    deletePersistedLiveSession: mockDeletePersistedLiveSession,
}));

vi.mock("@/lib/live-transcription/config", () => ({
    getLiveRuntimeEnvironment: mockGetLiveRuntimeEnvironment,
}));

function createRuntimeEnv(overrides?: {
    eventBufferSize?: number;
    sessionRetentionMinutes?: number;
}) {
    return {
        liveTranscriptionEnabled: true,
        whisperLiveEnabled: true,
        whisperLiveWsUrl: "ws://localhost:9090",
        defaultLanguage: null,
        defaultModel: "small",
        defaultTask: "transcribe",
        defaultUseVad: true,
        maxSessionMinutes: 90,
        maxChunkBytes: 256 * 1024,
        eventBufferSize: overrides?.eventBufferSize ?? 100,
        sessionRetentionMinutes: overrides?.sessionRetentionMinutes ?? 30,
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
    } as const;
}

describe("Live Transcription Runtime Worker", () => {
    let inboundHandler:
        | ((event: {
              type: "status" | "language" | "segments";
              status?: "SERVER_READY" | "WAIT" | "WARNING" | "ERROR" | "DISCONNECT";
              message?: string | null;
              language?: string;
              segments?: Array<{
                  id: string;
                  text: string;
                  startSec: number | null;
                  endSec: number | null;
                  isFinal: boolean;
              }>;
          }) => void)
        | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();

        mockGetLiveRuntimeEnvironment.mockReturnValue(createRuntimeEnv());
        mockPersistLiveSessionState.mockResolvedValue(undefined);
        mockPersistLiveSegment.mockResolvedValue(undefined);
        mockGetPersistedLiveSessionRecord.mockResolvedValue(null);
        mockGetPersistedLiveSessionSnapshot.mockResolvedValue(null);
        mockDeletePersistedLiveSession.mockResolvedValue(undefined);
        mockAdapterIsOpen.mockReturnValue(true);

        mockCreateWhisperLiveAdapter.mockImplementation((options) => {
            inboundHandler = options.onInbound;
            return {
                sendChunk: mockAdapterSendChunk,
                close: mockAdapterClose,
                isOpen: mockAdapterIsOpen,
            };
        });

        mockPersistFinalizedLiveSession.mockResolvedValue({
            recordingId: "rec-1",
            transcriptionId: "trans-1",
            storagePath: "user/live/session.wav",
            filesize: 100,
            fileMd5: "md5",
            durationMs: 1000,
        });
    });

    it("maps inbound events into normalized LiveEvents with monotonic seq ordering", async () => {
        const { LiveRuntimeRegistry } = await import(
            "@/lib/live-transcription/runtime-registry"
        );

        const registry = new LiveRuntimeRegistry();
        const session = await registry.createSession("user-1", {
            language: null,
            model: "small",
            task: "transcribe",
            useVad: true,
        });

        inboundHandler?.({
            type: "status",
            status: "SERVER_READY",
            message: null,
        });
        inboundHandler?.({
            type: "segments",
            segments: [
                {
                    id: "seg-1",
                    text: "hello",
                    startSec: 0,
                    endSec: 0.8,
                    isFinal: false,
                },
            ],
        });
        inboundHandler?.({
            type: "segments",
            segments: [
                {
                    id: "seg-2",
                    text: "world",
                    startSec: 0.8,
                    endSec: 1.6,
                    isFinal: true,
                },
            ],
        });

        const replay = await registry.getSessionEvents(session.id, "user-1", 0);

        expect(replay.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
        expect(replay.events.map((event) => event.type)).toEqual([
            "session.created",
            "session.ready",
            "transcript.segment",
            "transcript.segment",
        ]);
        expect(replay.snapshot.transcriptText).toBe("hello world");
        expect(replay.snapshot.transcriptSegments).toHaveLength(2);
    });

    it("maintains transcript ordering and replays only events after a given seq", async () => {
        const { LiveRuntimeRegistry } = await import(
            "@/lib/live-transcription/runtime-registry"
        );

        const registry = new LiveRuntimeRegistry();
        const session = await registry.createSession("user-1", {});

        inboundHandler?.({
            type: "segments",
            segments: [
                {
                    id: "seg-2",
                    text: "second",
                    startSec: 1,
                    endSec: 2,
                    isFinal: true,
                },
                {
                    id: "seg-1",
                    text: "first",
                    startSec: 0,
                    endSec: 1,
                    isFinal: true,
                },
            ],
        });

        const all = await registry.getSessionEvents(session.id, "user-1", 0);
        const afterFirst = await registry.getSessionEvents(session.id, "user-1", 1);

        expect(all.snapshot.transcriptText).toBe("second first");
        expect(afterFirst.events.every((event) => event.seq > 1)).toBe(true);
        expect(afterFirst.events).toHaveLength(Math.max(0, all.events.length - 1));
    });

    it("forwards audio chunks to the provider when the socket is open", async () => {
        const { LiveRuntimeRegistry } = await import(
            "@/lib/live-transcription/runtime-registry"
        );

        const registry = new LiveRuntimeRegistry();
        const session = await registry.createSession("user-1", {});

        const updated = registry.appendAudioChunk(
            session.id,
            "user-1",
            new Float32Array([0.1, -0.2, 0.3]),
        );

        expect(updated.audioSampleCount).toBe(3);
        expect(updated.audioBytesReceived).toBe(12);
        expect(mockAdapterSendChunk).toHaveBeenCalledTimes(1);
        expect(mockAdapterSendChunk).toHaveBeenCalledWith(
            expect.any(Float32Array),
        );
    });
});
