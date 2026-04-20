import { and, asc, desc, eq, lt, or } from "drizzle-orm";
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

export interface PersistedLiveSessionHistoryCursor {
    createdAt: string;
    id: string;
}

export interface PersistedLiveSessionHistoryItem {
    id: string;
    status: LiveTranscriptionStatus;
    createdAt: string;
    updatedAt: string;
    stoppedAt: string | null;
    finalizedAt: string | null;
    language: string | null;
    model: string | null;
    durationMs: number;
    recordingId: string | null;
    transcriptCharCount: number;
    transcriptPreview: string;
}

export interface ListPersistedLiveSessionHistoryInput {
    userId: string;
    limit: number;
    status?: LiveTranscriptionStatus | null;
    cursor?: {
        createdAt: Date;
        id: string;
    } | null;
}

export interface ListPersistedLiveSessionHistoryResult {
    items: PersistedLiveSessionHistoryItem[];
    nextCursor: PersistedLiveSessionHistoryCursor | null;
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
    lastSeq: number;
}

export interface PersistedLiveSessionState {
    snapshot: LiveSessionSnapshot;
    lastSeq: number;
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

function normalizeTranscriptText(
    metadata: PersistedLiveSessionMetadata,
): string {
    if (typeof metadata.transcriptText !== "string") {
        return "";
    }
    return metadata.transcriptText;
}

function toTranscriptPreview(text: string, maxChars = 240): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

function resolveDurationMs(
    duration: number | null,
    metadata: PersistedLiveSessionMetadata,
): number {
    if (typeof duration === "number" && Number.isFinite(duration)) {
        return Math.max(0, Math.round(duration));
    }

    const audioSampleCount = toOptionalNumber(metadata.audioSampleCount);
    if (typeof audioSampleCount === "number") {
        return calculateDurationMs(audioSampleCount, 16000);
    }

    return 0;
}

type PersistedSessionRow = typeof liveTranscriptionSessions.$inferSelect;
type PersistedSegmentRow = {
    segmentSeq: number;
    text: string;
    startMs: number;
    endMs: number;
    isFinal: boolean;
};

async function getPersistedSessionRow(
    sessionId: string,
    userId: string,
): Promise<PersistedSessionRow | null> {
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

    return sessionRow ?? null;
}

async function getPersistedSegmentRows(
    sessionId: string,
    userId: string,
): Promise<PersistedSegmentRow[]> {
    return await db
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
}

function buildPersistedSnapshot(
    sessionRow: PersistedSessionRow,
    segmentRows: PersistedSegmentRow[],
): LiveSessionSnapshot {
    const metadata = asMetadata(sessionRow.metadata);
    const config = resolveConfig(
        metadata,
        sessionRow.model,
        sessionRow.language,
    );
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
    const audioBytesReceived =
        toOptionalNumber(metadata.audioBytesReceived) ?? 0;
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
                      createdAt.getTime() +
                          config.maxSessionMinutes * 60 * 1000,
                  ).toISOString(),
        stoppedAt: sessionRow.stoppedAt
            ? sessionRow.stoppedAt.toISOString()
            : null,
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
                      message:
                          errorMessage ?? "Unknown live transcription error",
                      retryable:
                          errorCode === "provider-error" ||
                          errorCode === "provider-unavailable",
                  }
                : null,
    };
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
    const duration = calculateDurationMs(
        input.snapshot.audioSampleCount,
        16000,
    );
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
            lastSeq: liveTranscriptionSessions.lastSeq,
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
    const persistedState = await getPersistedLiveSessionState(
        sessionId,
        userId,
    );
    if (!persistedState) {
        return null;
    }

    return persistedState.snapshot;
}

export async function getPersistedLiveSessionState(
    sessionId: string,
    userId: string,
): Promise<PersistedLiveSessionState | null> {
    const sessionRow = await getPersistedSessionRow(sessionId, userId);
    if (!sessionRow) {
        return null;
    }

    const segmentRows = await getPersistedSegmentRows(sessionId, userId);
    return {
        snapshot: buildPersistedSnapshot(sessionRow, segmentRows),
        lastSeq: Math.max(0, sessionRow.lastSeq),
    };
}

export async function listPersistedLiveSessionHistory(
    input: ListPersistedLiveSessionHistoryInput,
): Promise<ListPersistedLiveSessionHistoryResult> {
    const pageSize = Math.max(1, Math.min(100, Math.floor(input.limit)));
    const cursor = input.cursor ?? null;

    const clauses = [eq(liveTranscriptionSessions.userId, input.userId)];
    if (input.status) {
        clauses.push(eq(liveTranscriptionSessions.status, input.status));
    }
    if (cursor) {
        const cursorPredicate = or(
            lt(liveTranscriptionSessions.startedAt, cursor.createdAt),
            and(
                eq(liveTranscriptionSessions.startedAt, cursor.createdAt),
                lt(liveTranscriptionSessions.id, cursor.id),
            ),
        );
        if (!cursorPredicate) {
            return {
                items: [],
                nextCursor: null,
            };
        }

        clauses.push(cursorPredicate);
    }

    const rows = await db
        .select({
            id: liveTranscriptionSessions.id,
            status: liveTranscriptionSessions.status,
            startedAt: liveTranscriptionSessions.startedAt,
            updatedAt: liveTranscriptionSessions.updatedAt,
            stoppedAt: liveTranscriptionSessions.stoppedAt,
            finalizedAt: liveTranscriptionSessions.finalizedAt,
            language: liveTranscriptionSessions.language,
            detectedLanguage: liveTranscriptionSessions.detectedLanguage,
            model: liveTranscriptionSessions.model,
            duration: liveTranscriptionSessions.duration,
            recordingId: liveTranscriptionSessions.recordingId,
            metadata: liveTranscriptionSessions.metadata,
        })
        .from(liveTranscriptionSessions)
        .where(and(...clauses))
        .orderBy(
            desc(liveTranscriptionSessions.startedAt),
            desc(liveTranscriptionSessions.id),
        )
        .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

    const items: PersistedLiveSessionHistoryItem[] = pageRows.map((row) => {
        const metadata = asMetadata(row.metadata);
        const transcriptText = normalizeTranscriptText(metadata);
        return {
            id: row.id,
            status: normalizeStatus(row.status),
            createdAt: row.startedAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
            finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
            language: row.detectedLanguage ?? row.language,
            model: row.model,
            durationMs: resolveDurationMs(row.duration, metadata),
            recordingId: row.recordingId,
            transcriptCharCount: transcriptText.length,
            transcriptPreview: toTranscriptPreview(transcriptText),
        };
    });

    const cursorRow = rows[pageSize];
    return {
        items,
        nextCursor:
            hasMore && cursorRow
                ? {
                      createdAt: cursorRow.startedAt.toISOString(),
                      id: cursorRow.id,
                  }
                : null,
    };
}
