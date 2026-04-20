import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { persistFinalizedLiveSession } from "@/lib/live-transcription/persistence";
import { createUserStorageProvider } from "@/lib/storage/factory";

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
    },
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(),
}));

vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi.fn(),
}));

function mockSelectResult(rows: unknown[]) {
    return {
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue(rows),
                }),
                limit: vi.fn().mockResolvedValue(rows),
            }),
        }),
    };
}

describe("Live Transcription Persistence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not create recording/transcription when there is no real audio", async () => {
        (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
            mockSelectResult([]),
        );

        const result = await persistFinalizedLiveSession({
            sessionId: "session-1",
            userId: "user-1",
            createdAt: new Date("2026-04-20T12:00:00.000Z"),
            finalizedAt: new Date("2026-04-20T12:05:00.000Z"),
            title: null,
            transcriptText: "hello world",
            language: "en",
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
            audioChunks: [],
            autoSummary: false,
        });

        expect(result).toEqual({
            recordingId: null,
            transcriptionId: null,
            storagePath: null,
            filesize: 0,
            fileMd5: null,
            durationMs: 0,
        });

        expect(createUserStorageProvider).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("returns existing persisted assets for idempotent retries", async () => {
        (db.select as ReturnType<typeof vi.fn>)
            .mockReturnValueOnce(
                mockSelectResult([
                    {
                        id: "rec-1",
                        storagePath: "user-1/live/existing.wav",
                        filesize: 100,
                        fileMd5: "0123456789abcdef0123456789abcdef",
                        duration: 2500,
                    },
                ]),
            )
            .mockReturnValueOnce(
                mockSelectResult([{ id: "trans-existing-1" }]),
            );

        const result = await persistFinalizedLiveSession({
            sessionId: "session-1",
            userId: "user-1",
            createdAt: new Date("2026-04-20T12:00:00.000Z"),
            finalizedAt: new Date("2026-04-20T12:05:00.000Z"),
            title: null,
            transcriptText: "already persisted",
            language: "en",
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
            audioChunks: [new Float32Array([0.1, 0.2])],
            autoSummary: false,
        });

        expect(result).toEqual({
            recordingId: "rec-1",
            transcriptionId: "trans-existing-1",
            storagePath: "user-1/live/existing.wav",
            filesize: 100,
            fileMd5: "0123456789abcdef0123456789abcdef",
            durationMs: 2500,
        });

        expect(createUserStorageProvider).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("creates recording + deterministic transcription id for new finalize", async () => {
        const mockUploadFile = vi.fn().mockResolvedValue(undefined);
        const mockDeleteFile = vi.fn().mockResolvedValue(undefined);
        (
            createUserStorageProvider as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            uploadFile: mockUploadFile,
            deleteFile: mockDeleteFile,
        });

        (
            generateTitleFromTranscription as ReturnType<typeof vi.fn>
        ).mockResolvedValue("Generated Title");

        (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
            mockSelectResult([]),
        );

        const recordingValues = vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "rec-1" }]),
        });
        const transcriptionOnConflict = vi.fn().mockReturnValue({
            returning: vi
                .fn()
                .mockResolvedValue([{ id: "live-transcription-session-1" }]),
        });
        const transcriptionValues = vi.fn().mockReturnValue({
            onConflictDoUpdate: transcriptionOnConflict,
        });

        (db.insert as ReturnType<typeof vi.fn>)
            .mockReturnValueOnce({
                values: recordingValues,
            })
            .mockReturnValueOnce({
                values: transcriptionValues,
            });

        const result = await persistFinalizedLiveSession({
            sessionId: "session-1",
            userId: "user-1",
            createdAt: new Date("2026-04-20T12:00:00.000Z"),
            finalizedAt: new Date("2026-04-20T12:05:00.000Z"),
            title: null,
            transcriptText: "Final transcript text",
            language: "en",
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
            audioChunks: [new Float32Array([0, 0.5, -0.5, 1])],
            autoSummary: false,
        });

        expect(result.recordingId).toBe("rec-1");
        expect(result.transcriptionId).toBe("live-transcription-session-1");
        expect(result.storagePath).toMatch(
            /^user-1\/live\/session-1-\d+\.wav$/,
        );
        expect(result.filesize).toBeGreaterThan(44);
        expect(result.fileMd5).toHaveLength(32);

        expect(recordingValues).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user-1",
                filename: "Generated Title",
                storageType: "local",
                plaudFileId: "live-session-1",
            }),
        );
        expect(transcriptionValues).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "live-transcription-session-1",
                recordingId: "rec-1",
                userId: "user-1",
                text: "Final transcript text",
                provider: "whisperlive",
                model: "small",
            }),
        );
    });
});
