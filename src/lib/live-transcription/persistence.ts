import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
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

export async function persistFinalizedLiveSession(
    input: PersistFinalizeInput,
): Promise<PersistFinalizeResult> {
    const wavResult = buildWavFromFloat32Chunks(input.audioChunks, 16000, 1);

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
    const durationMs = wavResult.durationMs;
    const storage = await createUserStorageProvider(input.userId);

    const storagePath = `${input.userId}/live/${input.sessionId}-${Date.now()}.wav`;
    await storage.uploadFile(storagePath, wavResult.wavBuffer, "audio/wav");

    const fileMd5 = createHash("md5").update(wavResult.wavBuffer).digest("hex");
    const filesize = wavResult.wavBuffer.byteLength;
    const startTime = input.createdAt;
    const endTime = new Date(startTime.getTime() + durationMs);
    const plaudFileId = `live-${input.sessionId}-${nanoid(6)}`;

    const [inserted] = await db
        .insert(recordings)
        .values({
            userId: input.userId,
            deviceSn: "live",
            plaudFileId,
            filename: recordingTitle,
            duration: durationMs,
            startTime,
            endTime,
            filesize,
            fileMd5,
            storageType: env.DEFAULT_STORAGE_TYPE,
            storagePath,
            downloadedAt: input.finalizedAt,
            plaudVersion: "live-relay-v1",
            isTrash: false,
        })
        .returning({ id: recordings.id });

    const recordingId = inserted.id;

    const [insertedTranscription] = await db
        .insert(transcriptions)
        .values({
            recordingId,
            userId: input.userId,
            text: input.transcriptText.trim() ? input.transcriptText : "",
            detectedLanguage: input.language,
            transcriptionType: "live",
            provider: "whisperlive",
            model: input.config.model,
        })
        .returning({ id: transcriptions.id });

    const transcriptionId: string | null = insertedTranscription.id;

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
