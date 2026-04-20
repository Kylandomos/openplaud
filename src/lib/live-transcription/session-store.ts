import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    liveTranscriptionSegments,
    liveTranscriptionSessions,
} from "@/db/schema";
import type {
    LiveErrorCode,
    LiveSessionConfig,
    LiveSessionSnapshot,
    LiveTranscriptionStatus,
    LiveTranscriptSegment,
} from "@/types/live-transcription";
import { calculateDurationMs } from "./audio";
import { getLiveRuntimeEnvironment } from "./config";

const LIVE_STATUSES: ReadonlySet<LiveTranscriptionStatus> = new Set([
    "initializing",
    "ready",
    "streaming",
    "stopping",
    "stopped",
    "finalizing",
    "finalized",
    "expired",
    "error",
]);

const LIVE_ERROR_CODES: ReadonlySet<LiveErrorCode> = new Set([
    "feature-disabled",
    "unauthorized",
    "forbidden",
    "not-found",
    "bad-request",
    "payload-too-large",
    "session-expired",
    "provider-unavailable",
    "provider-error",
    "runtime-error",
]);

interface PersistedLiveSessionMetadata {
    config?: LiveSessionConfig;
    expiresAt?: string;
    transcriptText?: string;
    audioBytesReceived?: number;
    audioSampleCount?: number;
    warning?: string | null;
    transcriptionId?: string | null;
}

export interface PersistLiveSessionStateInput {
    sessionId: string;
    userId: string;
    snapshot: LiveSessionSnapshot;
    lastSeq: number;
}

export interface PersistLiveSegmentInput {
    sessionId: string;
    userId: string;
    seq: number;
    segmentSeq: number;
    segment: LiveTranscriptSegment;
    language: string | null;
}

export interface PersistedLiveSessionRecord {
    id: string;
    userId: string;
    status: string;
    recordingId: string | null;
}

function toDateOrNull(value: string | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function toOptionalNumber(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    return value;
}

function asMetadata(value: unknown): PersistedLiveSessionMetadata {
    if (!value || typeof value !== "object") {
        return {};
    }
    return value as PersistedLiveSessionMetadata;
}

function normalizeStatus(raw: string): LiveTranscriptionStatus {
    if (LIVE_STATUSES.has(raw as LiveTranscriptionStatus)) {
        return raw as LiveTranscriptionStatus;
    }
    return "error";
}

function normalizeErrorCode(raw: string | null): LiveErrorCode | null {
    if (!raw) return null;
    if (LIVE_ERROR_CODES.has(raw as LiveErrorCode)) {
        return raw as LiveErrorCode;
    }
    return "runtime-error";
}

function toSegmentTimeMs(seconds: number | null): number {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return 0;
    return Math.max(0, Math.round(seconds * 1000));
}

function buildMetadata(
    snapshot: LiveSessionSnapshot,
): PersistedLiveSessionMetadata {
    return {
        config: snapshot.config,
        expiresAt: snapshot.expiresAt,
        transcriptText: snapshot.transcriptText,
        audioBytesReceived: snapshot.audioBytesReceived,
        audioSampleCount: snapshot.audioSampleCount,
        warning: snapshot.warning,
        transcriptionId: snapshot.transcriptionId,
    };
}

function resolveConfig(
    metadata: PersistedLiveSessionMetadata,
    persistedModel: string | null,
    persistedLanguage: string | null,
): LiveSessionConfig {
    const runtimeEnv = getLiveRuntimeEnvironment();
    const savedConfig = metadata.config;

    return {
        provider:
            savedConfig?.provider === "whisperlive"
                ? savedConfig.provider
                : "whisperlive",
        transport:
            savedConfig?.transport === "relay"
                ? savedConfig.transport
                : "relay",
        language:
            typeof savedConfig?.language === "string"
                ? savedConfig.language
                : savedConfig?.language === null
                  ? null
                  : persistedLanguage,
        model:
            typeof savedConfig?.model === "string" && savedConfig.model.trim()
                ? savedConfig.model.trim()
                : persistedModel?.trim() || runtimeEnv.defaultModel,
        task:
            savedConfig?.task === "translate"
                ? "translate"
                : savedConfig?.task === "transcribe"
                  ? "transcribe"
                  : runtimeEnv.defaultTask,
        useVad:
            typeof savedConfig?.useVad === "boolean"
                ? savedConfig.useVad
                : runtimeEnv.defaultUseVad,
        maxSessionMinutes:
            typeof savedConfig?.maxSessionMinutes === "number" &&
            Number.isFinite(savedConfig.maxSessionMinutes) &&
            savedConfig.maxSessionMinutes > 0
                ? Math.round(savedConfig.maxSessionMinutes)
                : runtimeEnv.maxSessionMinutes,
        maxChunkBytes:
            typeof savedConfig?.maxChunkBytes === "number" &&
            Number.isFinite(savedConfig.maxChunkBytes) &&
            savedConfig.maxChunkBytes > 0
                ? Math.round(savedConfig.maxChunkBytes)
                : runtimeEnv.maxChunkBytes,
    };
}

function resolveSegments(
    rows: {
        segmentSeq: number;
        text: string;
        startMs: number;
        endMs: number;
        isFinal: boolean;
    }[],
): LiveTranscriptSegment[] {
    const latestBySegmentSeq = new Map<number, (typeof rows)[number]>();
    for (const row of rows) {
        latestBySegmentSeq.set(row.segmentSeq, row);
    }

    return Array.from(latestBySegmentSeq.entries())
        .sort(([left], [right]) => left - right)
        .map(([segmentSeq, row]) => ({
            id: `segment-${segmentSeq}`,
            text: row.text,
            startSec: row.startMs / 1000,
            endSec: row.endMs / 1000,
            isFinal: row.isFinal,
        }));
}

export async function persistLiveSessionState(
    input: PersistLiveSessionStateInput,
): Promise<void> {
    const now = new Date();
    const createdAt =
        toDateOrNull(input.snapshot.createdAt) ||
        toDateOrNull(input.snapshot.updatedAt) ||
        now;
    const updatedAt = toDateOrNull(input.snapshot.updatedAt) || now;
    const stoppedAt = toDateOrNull(input.snapshot.stoppedAt);
    const finalizedAt = toDateOrNull(input.snapshot.finalizedAt);
    const duration = calculateDurationMs(input.snapshot.audioSampleCount, 16000);
    const metadata = buildMetadata(input.snapshot);

    await db
        .insert(liveTranscriptionSessions)
        .values({
            id: input.sessionId,
            userId: input.userId,
            status: input.snapshot.status,
            provider: input.snapshot.config.provider,
            model: input.snapshot.config.model,
            language: input.snapshot.config.language,
            detectedLanguage: input.snapshot.language,
            startedAt: createdAt,
            stoppedAt,
            finalizedAt,
            duration,
            lastSeq: Math.max(0, input.lastSeq),
            errorCode: input.snapshot.error?.code,
            errorMessage: input.snapshot.error?.message,
            recordingId: input.snapshot.recordingId,
            metadata,
            createdAt,
            updatedAt,
        })
        .onConflictDoUpdate({
            target: liveTranscriptionSessions.id,
            set: {
                status: input.snapshot.status,
                provider: input.snapshot.config.provider,
                model: input.snapshot.config.model,
                language: input.snapshot.config.language,
                detectedLanguage: input.snapshot.language,
                startedAt: createdAt,
                stoppedAt,
                finalizedAt,
                duration,
                lastSeq: Math.max(0, input.lastSeq),
                errorCode: input.snapshot.error?.code,
                errorMessage: input.snapshot.error?.message,
                recordingId: input.snapshot.recordingId,
                metadata,
                updatedAt,
            },
        });
}

export async function persistLiveSegment(input: PersistLiveSegmentInput) {
    const startMs = toSegmentTimeMs(input.segment.startSec);
    const endMsRaw = toSegmentTimeMs(input.segment.endSec);
    const endMs = Math.max(startMs, endMsRaw);

    await db
        .insert(liveTranscriptionSegments)
        .values({
            sessionId: input.sessionId,
            userId: input.userId,
            seq: input.seq,
            segmentSeq: input.segmentSeq,
            startMs,
            endMs,
            text: input.segment.text,
            isFinal: input.segment.isFinal,
            language: input.language,
            confidence: null,
        })
        .onConflictDoUpdate({
            target: [
                liveTranscriptionSegments.sessionId,
                liveTranscriptionSegments.seq,
            ],
            set: {
                segmentSeq: input.segmentSeq,
                startMs,
                endMs,
                text: input.segment.text,
                isFinal: input.segment.isFinal,
                language: input.language,
            },
        });
}

export async function getPersistedLiveSessionRecord(
    sessionId: string,
    userId: string,
): Promise<PersistedLiveSessionRecord | null> {
    const [row] = await db
        .select({
            id: liveTranscriptionSessions.id,
            userId: liveTranscriptionSessions.userId,
            status: liveTranscriptionSessions.status,
            recordingId: liveTranscriptionSessions.recordingId,
        })
        .from(liveTranscriptionSessions)
        .where(
            and(
                eq(liveTranscriptionSessions.id, sessionId),
                eq(liveTranscriptionSessions.userId, userId),
            ),
        )
        .limit(1);

    return row ?? null;
}

export async function deletePersistedLiveSession(
    sessionId: string,
    userId: string,
): Promise<void> {
    await db
        .delete(liveTranscriptionSessions)
        .where(
            and(
                eq(liveTranscriptionSessions.id, sessionId),
                eq(liveTranscriptionSessions.userId, userId),
            ),
        );
}

export async function getPersistedLiveSessionSnapshot(
    sessionId: string,
    userId: string,
): Promise<LiveSessionSnapshot | null> {
    const [sessionRow] = await db
        .select()
        .from(liveTranscriptionSessions)
        .where(
            and(
                eq(liveTranscriptionSessions.id, sessionId),
                eq(liveTranscriptionSessions.userId, userId),
            ),
        )
        .limit(1);

    if (!sessionRow) {
        return null;
    }

    const segmentRows = await db
        .select({
            segmentSeq: liveTranscriptionSegments.segmentSeq,
            text: liveTranscriptionSegments.text,
            startMs: liveTranscriptionSegments.startMs,
            endMs: liveTranscriptionSegments.endMs,
            isFinal: liveTranscriptionSegments.isFinal,
        })
        .from(liveTranscriptionSegments)
        .where(
            and(
                eq(liveTranscriptionSegments.sessionId, sessionId),
                eq(liveTranscriptionSegments.userId, userId),
            ),
        )
        .orderBy(
            asc(liveTranscriptionSegments.seq),
            asc(liveTranscriptionSegments.segmentSeq),
        );

    const metadata = asMetadata(sessionRow.metadata);
    const config = resolveConfig(metadata, sessionRow.model, sessionRow.language);
    const createdAt = sessionRow.startedAt ?? sessionRow.createdAt;
    const resolvedSegments = resolveSegments(segmentRows);
    const transcriptText =
        typeof metadata.transcriptText === "string"
            ? metadata.transcriptText
            : resolvedSegments
                  .map((segment) => segment.text)
                  .join(" ")
                  .replace(/\s+/g, " ")
                  .trim();
    const audioBytesReceived = toOptionalNumber(metadata.audioBytesReceived) ?? 0;
    const audioSampleCount = toOptionalNumber(metadata.audioSampleCount) ?? 0;

    const warning =
        typeof metadata.warning === "string" ? metadata.warning : null;
    const transcriptionId =
        typeof metadata.transcriptionId === "string"
            ? metadata.transcriptionId
            : null;

    const errorCode = normalizeErrorCode(sessionRow.errorCode);
    const errorMessage = sessionRow.errorMessage;

    return {
        id: sessionRow.id,
        status: normalizeStatus(sessionRow.status),
        config,
        createdAt: createdAt.toISOString(),
        updatedAt: sessionRow.updatedAt.toISOString(),
        expiresAt:
            typeof metadata.expiresAt === "string"
                ? metadata.expiresAt
                : new Date(
                      createdAt.getTime() + config.maxSessionMinutes * 60 * 1000,
                  ).toISOString(),
        stoppedAt: sessionRow.stoppedAt ? sessionRow.stoppedAt.toISOString() : null,
        finalizedAt: sessionRow.finalizedAt
            ? sessionRow.finalizedAt.toISOString()
            : null,
        language: sessionRow.detectedLanguage ?? sessionRow.language,
        transcriptText,
        transcriptSegments: resolvedSegments,
        audioBytesReceived,
        audioSampleCount,
        recordingId: sessionRow.recordingId,
        transcriptionId,
        warning,
        error:
            errorCode || errorMessage
                ? {
                      code: errorCode ?? "runtime-error",
                      message: errorMessage ?? "Unknown live transcription error",
                      retryable:
                          errorCode === "provider-error" ||
                          errorCode === "provider-unavailable",
                  }
                : null,
    };
}
