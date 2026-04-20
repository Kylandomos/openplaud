import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { env } from "@/lib/env";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { LiveSessionConfig } from "@/types/live-transcription";
import { buildWavFromFloat32Chunks } from "./audio";

interface PersistFinalizeInput {
    sessionId: string;
    userId: string;
    createdAt: Date;
    finalizedAt: Date;
    title: string | null;
    transcriptText: string;
    language: string | null;
    config: LiveSessionConfig;
    audioChunks: Float32Array[];
    autoSummary: boolean;
}

export interface PersistFinalizeResult {
    recordingId: string | null;
    transcriptionId: string | null;
    storagePath: string | null;
    filesize: number;
    fileMd5: string | null;
    durationMs: number;
}

interface ExistingLiveAssets {
    recordingId: string;
    transcriptionId: string | null;
    storagePath: string;
    filesize: number;
    fileMd5: string;
    durationMs: number;
}

function fallbackTitle(createdAt: Date): string {
    const iso = createdAt.toISOString().replace("T", " ").replace("Z", " UTC");
    return `Live transcription ${iso}`;
}

async function resolveRecordingTitle(
    userId: string,
    requestedTitle: string | null,
    transcriptText: string,
    createdAt: Date,
): Promise<string> {
    if (requestedTitle?.trim()) {
        return requestedTitle.trim();
    }

    if (transcriptText.trim()) {
        const generated = await generateTitleFromTranscription(
            userId,
            transcriptText,
        );
        if (generated?.trim()) {
            return generated.trim();
        }
    }

    return fallbackTitle(createdAt);
}

async function maybeGenerateSummary(
    userId: string,
    recordingId: string,
): Promise<void> {
    const modulePath = "../ai/generate-summary";
    const loaded = await import(modulePath).catch(() => null);
    if (!loaded || typeof loaded !== "object") {
        return;
    }

    const candidate = loaded as {
        generateSummaryForRecording?: (
            userId: string,
            recordingId: string,
        ) => Promise<void>;
    };

    if (typeof candidate.generateSummaryForRecording === "function") {
        await candidate.generateSummaryForRecording(userId, recordingId);
    }
}

function getLivePlaudFileId(sessionId: string): string {
    return `live-${sessionId}`;
}

function getLiveTranscriptionId(sessionId: string): string {
    return `live-transcription-${sessionId}`;
}

function isUniqueConstraintError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }
    const maybeCode = (error as { code?: unknown }).code;
    return typeof maybeCode === "string" && maybeCode === "23505";
}

async function getExistingLiveAssets(
    userId: string,
    sessionId: string,
): Promise<ExistingLiveAssets | null> {
    const [recording] = await db
        .select({
            id: recordings.id,
            storagePath: recordings.storagePath,
            filesize: recordings.filesize,
            fileMd5: recordings.fileMd5,
            duration: recordings.duration,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.userId, userId),
                eq(recordings.plaudFileId, getLivePlaudFileId(sessionId)),
            ),
        )
        .limit(1);

    if (!recording) {
        return null;
    }

    const [transcription] = await db
        .select({ id: transcriptions.id })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.userId, userId),
                eq(transcriptions.recordingId, recording.id),
            ),
        )
        .orderBy(desc(transcriptions.createdAt))
        .limit(1);

    return {
        recordingId: recording.id,
        transcriptionId: transcription?.id ?? null,
        storagePath: recording.storagePath,
        filesize: recording.filesize,
        fileMd5: recording.fileMd5,
        durationMs: recording.duration,
    };
}

async function upsertLiveTranscription(
    sessionId: string,
    recordingId: string,
    userId: string,
    transcriptText: string,
    language: string | null,
    model: string,
): Promise<string> {
    const [upserted] = await db
        .insert(transcriptions)
        .values({
            id: getLiveTranscriptionId(sessionId),
            recordingId,
            userId,
            text: transcriptText.trim() ? transcriptText : "",
            detectedLanguage: language,
            transcriptionType: "live",
            provider: "whisperlive",
            model,
        })
        .onConflictDoUpdate({
            target: transcriptions.id,
            set: {
                recordingId,
                userId,
                text: transcriptText.trim() ? transcriptText : "",
                detectedLanguage: language,
                transcriptionType: "live",
                provider: "whisperlive",
                model,
            },
        })
        .returning({ id: transcriptions.id });

    return upserted.id;
}

export async function persistFinalizedLiveSession(
    input: PersistFinalizeInput,
): Promise<PersistFinalizeResult> {
    const existingAssets = await getExistingLiveAssets(
        input.userId,
        input.sessionId,
    );
    if (existingAssets?.transcriptionId) {
        return {
            recordingId: existingAssets.recordingId,
            transcriptionId: existingAssets.transcriptionId,
            storagePath: existingAssets.storagePath,
            filesize: existingAssets.filesize,
            fileMd5: existingAssets.fileMd5,
            durationMs: existingAssets.durationMs,
        };
    }

    let recordingId = existingAssets?.recordingId ?? null;
    let storagePath = existingAssets?.storagePath ?? null;
    let filesize = existingAssets?.filesize ?? 0;
    let fileMd5 = existingAssets?.fileMd5 ?? null;
    let durationMs = existingAssets?.durationMs ?? 0;

    if (!recordingId) {
        const wavResult = buildWavFromFloat32Chunks(
            input.audioChunks,
            16000,
            1,
        );
        if (!wavResult) {
            return {
                recordingId: null,
                transcriptionId: null,
                storagePath: null,
                filesize: 0,
                fileMd5: null,
                durationMs: 0,
            };
        }

        const recordingTitle = await resolveRecordingTitle(
            input.userId,
            input.title,
            input.transcriptText,
            input.createdAt,
        );
        durationMs = wavResult.durationMs;
        const storage = await createUserStorageProvider(input.userId);
        const candidateStoragePath = `${input.userId}/live/${input.sessionId}-${Date.now()}.wav`;
        await storage.uploadFile(
            candidateStoragePath,
            wavResult.wavBuffer,
            "audio/wav",
        );

        const calculatedMd5 = createHash("md5")
            .update(wavResult.wavBuffer)
            .digest("hex");
        const calculatedFilesize = wavResult.wavBuffer.byteLength;
        const startTime = input.createdAt;
        const endTime = new Date(startTime.getTime() + durationMs);

        try {
            const [inserted] = await db
                .insert(recordings)
                .values({
                    userId: input.userId,
                    deviceSn: "live",
                    plaudFileId: getLivePlaudFileId(input.sessionId),
                    filename: recordingTitle,
                    duration: durationMs,
                    startTime,
                    endTime,
                    filesize: calculatedFilesize,
                    fileMd5: calculatedMd5,
                    storageType: env.DEFAULT_STORAGE_TYPE,
                    storagePath: candidateStoragePath,
                    downloadedAt: input.finalizedAt,
                    plaudVersion: "live-relay-v1",
                    isTrash: false,
                })
                .returning({ id: recordings.id });

            recordingId = inserted.id;
            storagePath = candidateStoragePath;
            filesize = calculatedFilesize;
            fileMd5 = calculatedMd5;
        } catch (error) {
            if (!isUniqueConstraintError(error)) {
                throw error;
            }

            const racedAssets = await getExistingLiveAssets(
                input.userId,
                input.sessionId,
            );
            if (!racedAssets) {
                throw error;
            }

            try {
                await storage.deleteFile(candidateStoragePath);
            } catch {
                // best-effort cleanup
            }

            recordingId = racedAssets.recordingId;
            storagePath = racedAssets.storagePath;
            filesize = racedAssets.filesize;
            fileMd5 = racedAssets.fileMd5;
            durationMs = racedAssets.durationMs;
        }
    }

    if (!recordingId) {
        return {
            recordingId: null,
            transcriptionId: null,
            storagePath,
            filesize,
            fileMd5,
            durationMs,
        };
    }

    const transcriptionId = await upsertLiveTranscription(
        input.sessionId,
        recordingId,
        input.userId,
        input.transcriptText,
        input.language,
        input.config.model,
    );

    if (recordingId && input.autoSummary) {
        try {
            await maybeGenerateSummary(input.userId, recordingId);
        } catch (error) {
            console.error("Failed to generate live-session summary:", error);
        }
    }

    return {
        recordingId,
        transcriptionId,
        storagePath,
        filesize,
        fileMd5,
        durationMs,
    };
}
