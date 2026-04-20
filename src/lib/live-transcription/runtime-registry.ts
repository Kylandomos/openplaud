import { nanoid } from "nanoid";
import type {
    CreateLiveTranscriptionRequest,
    FinalizeLiveTranscriptionRequest,
    LiveError,
    LiveErrorCode,
    LiveEvent,
    LiveSessionConfig,
    LiveSessionSnapshot,
    LiveTranscriptionStatus,
} from "@/types/live-transcription";
import { calculateDurationMs } from "./audio";
import { getLiveRuntimeEnvironment } from "./config";
import { liveEventBus } from "./event-bus";
import { persistFinalizedLiveSession } from "./persistence";
import {
    deletePersistedLiveSession,
    getPersistedLiveSessionRecord,
    getPersistedLiveSessionSnapshot,
    getPersistedLiveSessionState,
    listPersistedLiveSessionHistory,
    type PersistedLiveSessionHistoryCursor,
    type PersistedLiveSessionHistoryItem,
    persistLiveSegment,
    persistLiveSessionState,
} from "./session-store";
import {
    createWhisperLiveAdapter,
    type WhisperLiveAdapter,
    type WhisperLiveInboundEvent,
} from "./whisperlive-adapter";

interface LiveRuntimeSession {
    id: string;
    userId: string;
    snapshot: LiveSessionSnapshot;
    events: LiveEvent[];
    nextSeq: number;
    adapter: WhisperLiveAdapter | null;
    audioChunks: Float32Array[];
    sentChunkCount: number;
    segmentOrder: string[];
    segmentSeqById: Map<string, number>;
    segmentMap: Map<string, LiveSessionSnapshot["transcriptSegments"][number]>;
    cleanupTimer: NodeJS.Timeout | null;
    finalizePromise: Promise<{
        snapshot: LiveSessionSnapshot;
        recordingId: string | null;
    }> | null;
}

interface SessionLookup {
    runtime: LiveRuntimeSession;
}

interface LiveSessionReadState {
    snapshot: LiveSessionSnapshot;
    isActive: boolean;
    lastSeq: number;
}

export class LiveSessionError extends Error {
    code: LiveErrorCode;
    httpStatus: number;
    details?: Record<string, string | number | boolean | null>;

    constructor(
        code: LiveErrorCode,
        message: string,
        httpStatus: number,
        details?: Record<string, string | number | boolean | null>,
    ) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }

    toLiveError(): LiveError {
        return {
            code: this.code,
            message: this.message,
            details: this.details,
            retryable: this.code === "provider-unavailable",
        };
    }
}

function createSessionConfig(
    overrides: CreateLiveTranscriptionRequest | undefined,
): LiveSessionConfig {
    const runtimeEnv = getLiveRuntimeEnvironment();

    const language =
        typeof overrides?.language === "string" && overrides.language.trim()
            ? overrides.language.trim()
            : overrides?.language === null
              ? null
              : runtimeEnv.defaultLanguage;

    return {
        provider: "whisperlive",
        transport: "relay",
        language,
        model:
            typeof overrides?.model === "string" && overrides.model.trim()
                ? overrides.model.trim()
                : runtimeEnv.defaultModel,
        task:
            overrides?.task === "translate"
                ? "translate"
                : runtimeEnv.defaultTask,
        useVad:
            typeof overrides?.useVad === "boolean"
                ? overrides.useVad
                : runtimeEnv.defaultUseVad,
        maxSessionMinutes: runtimeEnv.maxSessionMinutes,
        maxChunkBytes: runtimeEnv.maxChunkBytes,
    };
}

function createSnapshot(
    id: string,
    config: LiveSessionConfig,
    createdAt: Date,
): LiveSessionSnapshot {
    const expiresAt = new Date(
        createdAt.getTime() + config.maxSessionMinutes * 60 * 1000,
    );
    const createdIso = createdAt.toISOString();

    return {
        id,
        status: "initializing",
        config,
        createdAt: createdIso,
        updatedAt: createdIso,
        expiresAt: expiresAt.toISOString(),
        stoppedAt: null,
        finalizedAt: null,
        language: config.language,
        transcriptText: "",
        transcriptSegments: [],
        audioBytesReceived: 0,
        audioSampleCount: 0,
        recordingId: null,
        transcriptionId: null,
        warning: null,
        error: null,
    };
}

export class LiveRuntimeRegistry {
    private readonly sessions = new Map<string, LiveRuntimeSession>();

    getCapabilities() {
        return getLiveRuntimeEnvironment().capabilities;
    }

    createSession(
        userId: string,
        request: CreateLiveTranscriptionRequest | undefined,
    ): LiveSessionSnapshot {
        const sessionId = nanoid();
        const config = createSessionConfig(request);
        const createdAt = new Date();
        const snapshot = createSnapshot(sessionId, config, createdAt);

        const runtime: LiveRuntimeSession = {
            id: sessionId,
            userId,
            snapshot,
            events: [],
            nextSeq: 1,
            adapter: null,
            audioChunks: [],
            sentChunkCount: 0,
            segmentOrder: [],
            segmentSeqById: new Map(),
            segmentMap: new Map(),
            cleanupTimer: null,
            finalizePromise: null,
        };

        this.sessions.set(sessionId, runtime);
        this.emit(runtime, "session.created");
        this.queuePersistSession(runtime);
        this.connectProvider(runtime);

        return runtime.snapshot;
    }

    getSessionSnapshot(sessionId: string, userId: string): LiveSessionSnapshot {
        return this.lookupSession(sessionId, userId).runtime.snapshot;
    }

    async getSessionSnapshotForRead(
        sessionId: string,
        userId: string,
    ): Promise<LiveSessionSnapshot> {
        try {
            return this.getSessionSnapshot(sessionId, userId);
        } catch (error) {
            if (
                !(error instanceof LiveSessionError) ||
                error.code !== "not-found"
            ) {
                throw error;
            }
        }

        const persisted = await getPersistedLiveSessionSnapshot(
            sessionId,
            userId,
        );
        if (!persisted) {
            throw new LiveSessionError(
                "not-found",
                "Live transcription session not found",
                404,
            );
        }

        return persisted;
    }

    getSessionEvents(
        sessionId: string,
        userId: string,
        afterSeq = 0,
    ): { snapshot: LiveSessionSnapshot; events: LiveEvent[]; lastSeq: number } {
        const { runtime } = this.lookupSession(sessionId, userId);
        const events = runtime.events.filter((event) => event.seq > afterSeq);
        return {
            snapshot: runtime.snapshot,
            events,
            lastSeq: Math.max(0, runtime.nextSeq - 1),
        };
    }

    async getSessionEventsForRead(
        sessionId: string,
        userId: string,
        afterSeq = 0,
    ): Promise<{
        snapshot: LiveSessionSnapshot;
        events: LiveEvent[];
        isActive: boolean;
        lastSeq: number;
    }> {
        try {
            const active = this.getSessionEvents(sessionId, userId, afterSeq);
            return {
                snapshot: active.snapshot,
                events: active.events,
                isActive: this.isSessionActive(active.snapshot),
                lastSeq: active.lastSeq,
            };
        } catch (error) {
            if (
                !(error instanceof LiveSessionError) ||
                error.code !== "not-found"
            ) {
                throw error;
            }
        }

        const persisted = await getPersistedLiveSessionState(sessionId, userId);
        if (!persisted) {
            throw new LiveSessionError(
                "not-found",
                "Live transcription session not found",
                404,
            );
        }

        return {
            snapshot: persisted.snapshot,
            events: [],
            isActive: false,
            lastSeq: persisted.lastSeq,
        };
    }

    async getSessionReadStateForRead(
        sessionId: string,
        userId: string,
    ): Promise<LiveSessionReadState> {
        const runtime = this.sessions.get(sessionId);
        if (runtime) {
            if (runtime.userId !== userId) {
                throw new LiveSessionError(
                    "forbidden",
                    "You do not have access to this live session",
                    403,
                );
            }
            this.ensureNotExpired(runtime, true);
            return this.createReadStateFromRuntime(runtime);
        }

        const persisted = await getPersistedLiveSessionState(sessionId, userId);
        if (!persisted) {
            throw new LiveSessionError(
                "not-found",
                "Live transcription session not found",
                404,
            );
        }

        return {
            snapshot: persisted.snapshot,
            isActive: false,
            lastSeq: persisted.lastSeq,
        };
    }

    async listSessionHistoryForRead(
        userId: string,
        options?: {
            limit?: number;
            cursor?: { createdAt: Date; id: string } | null;
            status?: LiveTranscriptionStatus | null;
        },
    ): Promise<{
        items: PersistedLiveSessionHistoryItem[];
        nextCursor: PersistedLiveSessionHistoryCursor | null;
    }> {
        const limit = options?.limit ?? 20;
        return await listPersistedLiveSessionHistory({
            userId,
            limit,
            cursor: options?.cursor ?? null,
            status: options?.status ?? null,
        });
    }

    subscribe(
        sessionId: string,
        userId: string,
        listener: (event: LiveEvent) => void,
    ): () => void {
        this.lookupSession(sessionId, userId);
        return liveEventBus.subscribe(sessionId, listener);
    }

    appendAudioChunk(
        sessionId: string,
        userId: string,
        chunk: Float32Array,
    ): LiveSessionSnapshot {
        if (chunk.length === 0) {
            return this.lookupSession(sessionId, userId).runtime.snapshot;
        }

        const { runtime } = this.lookupSession(sessionId, userId);
        this.ensureNotExpired(runtime);

        if (
            runtime.snapshot.status === "finalizing" ||
            runtime.snapshot.status === "finalized"
        ) {
            throw new LiveSessionError(
                "bad-request",
                "Session is already finalized",
                409,
            );
        }

        const copiedChunk = new Float32Array(chunk);
        runtime.audioChunks.push(copiedChunk);

        runtime.snapshot.audioSampleCount += copiedChunk.length;
        runtime.snapshot.audioBytesReceived += copiedChunk.byteLength;
        runtime.snapshot.updatedAt = new Date().toISOString();

        if (
            runtime.snapshot.status === "ready" ||
            runtime.snapshot.status === "initializing"
        ) {
            runtime.snapshot.status = "streaming";
        }

        this.flushPendingAudio(runtime);
        this.queuePersistSession(runtime);

        return runtime.snapshot;
    }

    stopSession(sessionId: string, userId: string): LiveSessionSnapshot {
        const { runtime } = this.lookupSession(sessionId, userId);
        this.ensureNotExpired(runtime, true);

        if (
            runtime.snapshot.status === "stopped" ||
            runtime.snapshot.status === "finalizing" ||
            runtime.snapshot.status === "finalized"
        ) {
            this.queuePersistSession(runtime);
            return runtime.snapshot;
        }

        runtime.snapshot.status = "stopping";
        runtime.snapshot.updatedAt = new Date().toISOString();
        runtime.adapter?.close();

        runtime.snapshot.status = "stopped";
        runtime.snapshot.stoppedAt = new Date().toISOString();
        runtime.snapshot.updatedAt = runtime.snapshot.stoppedAt;
        this.emit(runtime, "session.stopped");
        this.queuePersistSession(runtime);
        this.scheduleCleanup(runtime);

        return runtime.snapshot;
    }

    async finalizeSession(
        sessionId: string,
        userId: string,
        request: FinalizeLiveTranscriptionRequest | undefined,
    ): Promise<{ snapshot: LiveSessionSnapshot; recordingId: string | null }> {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
            const persisted = await getPersistedLiveSessionState(
                sessionId,
                userId,
            );
            if (!persisted) {
                throw new LiveSessionError(
                    "not-found",
                    "Live transcription session not found",
                    404,
                );
            }

            if (persisted.snapshot.recordingId) {
                return {
                    snapshot: persisted.snapshot,
                    recordingId: persisted.snapshot.recordingId,
                };
            }

            throw new LiveSessionError(
                "bad-request",
                "Live transcription session is no longer active and cannot be finalized",
                409,
            );
        }

        if (runtime.userId !== userId) {
            throw new LiveSessionError(
                "forbidden",
                "You do not have access to this live session",
                403,
            );
        }

        this.ensureNotExpired(runtime, true);

        if (runtime.finalizePromise) {
            return await runtime.finalizePromise;
        }

        if (runtime.snapshot.status === "finalized") {
            await this.persistSession(runtime);
            return {
                snapshot: runtime.snapshot,
                recordingId: runtime.snapshot.recordingId,
            };
        }

        runtime.finalizePromise = this.runFinalize(runtime, request).finally(
            () => {
                runtime.finalizePromise = null;
            },
        );

        return await runtime.finalizePromise;
    }

    async discardSession(sessionId: string, userId: string): Promise<void> {
        const runtime = this.sessions.get(sessionId);

        if (runtime) {
            if (runtime.userId !== userId) {
                throw new LiveSessionError(
                    "forbidden",
                    "You do not have access to this live session",
                    403,
                );
            }

            if (runtime.snapshot.recordingId) {
                throw new LiveSessionError(
                    "bad-request",
                    "Cannot discard a saved live transcription session",
                    409,
                );
            }

            if (runtime.cleanupTimer) {
                clearTimeout(runtime.cleanupTimer);
            }
            this.sessions.delete(sessionId);
            runtime.adapter?.close();
            await deletePersistedLiveSession(sessionId, userId);
            return;
        }

        const persisted = await getPersistedLiveSessionRecord(
            sessionId,
            userId,
        );
        if (!persisted) {
            throw new LiveSessionError(
                "not-found",
                "Live transcription session not found",
                404,
            );
        }

        if (persisted.recordingId) {
            throw new LiveSessionError(
                "bad-request",
                "Cannot discard a saved live transcription session",
                409,
            );
        }

        await deletePersistedLiveSession(sessionId, userId);
    }

    private connectProvider(runtime: LiveRuntimeSession): void {
        runtime.adapter = createWhisperLiveAdapter({
            wsUrl: getLiveRuntimeEnvironment().whisperLiveWsUrl,
            uid: runtime.id,
            config: runtime.snapshot.config,
            onOpen: () => {
                if (!this.sessions.has(runtime.id)) return;
                this.flushPendingAudio(runtime);
            },
            onClose: () => {
                if (!this.sessions.has(runtime.id)) return;
                if (
                    runtime.snapshot.status !== "finalizing" &&
                    runtime.snapshot.status !== "finalized"
                ) {
                    if (
                        runtime.snapshot.status !== "stopped" &&
                        runtime.snapshot.status !== "expired"
                    ) {
                        runtime.snapshot.status = "stopped";
                        runtime.snapshot.stoppedAt = new Date().toISOString();
                    }
                    runtime.snapshot.updatedAt = new Date().toISOString();
                }
                this.emit(runtime, "session.disconnected");
                this.queuePersistSession(runtime);
            },
            onError: (message) => {
                if (!this.sessions.has(runtime.id)) return;
                this.setError(runtime, "provider-error", message);
            },
            onInbound: (event) => {
                if (!this.sessions.has(runtime.id)) return;
                this.handleInbound(runtime, event);
            },
        });
    }

    private handleInbound(
        runtime: LiveRuntimeSession,
        inbound: WhisperLiveInboundEvent,
    ): void {
        this.ensureNotExpired(runtime, true);

        if (inbound.type === "status") {
            switch (inbound.status) {
                case "WAIT":
                    runtime.snapshot.warning =
                        inbound.message || "Provider is warming up";
                    runtime.snapshot.updatedAt = new Date().toISOString();
                    this.emit(runtime, "session.warning", {
                        warning: runtime.snapshot.warning,
                    });
                    this.queuePersistSession(runtime);
                    return;
                case "WARNING":
                    runtime.snapshot.warning =
                        inbound.message || "Provider warning received";
                    runtime.snapshot.updatedAt = new Date().toISOString();
                    this.emit(runtime, "session.warning", {
                        warning: runtime.snapshot.warning,
                    });
                    this.queuePersistSession(runtime);
                    return;
                case "ERROR":
                    this.setError(
                        runtime,
                        "provider-error",
                        inbound.message || "Provider returned an error",
                    );
                    return;
                case "SERVER_READY":
                    if (
                        runtime.snapshot.status === "initializing" ||
                        runtime.snapshot.status === "stopped"
                    ) {
                        runtime.snapshot.status = "ready";
                    }
                    runtime.snapshot.warning = null;
                    runtime.snapshot.updatedAt = new Date().toISOString();
                    this.emit(runtime, "session.ready");
                    this.flushPendingAudio(runtime);
                    this.queuePersistSession(runtime);
                    return;
                case "DISCONNECT":
                    if (
                        runtime.snapshot.status !== "finalizing" &&
                        runtime.snapshot.status !== "finalized"
                    ) {
                        runtime.snapshot.status = "stopped";
                        runtime.snapshot.stoppedAt = new Date().toISOString();
                        runtime.snapshot.updatedAt = runtime.snapshot.stoppedAt;
                    }
                    this.emit(runtime, "session.disconnected");
                    this.queuePersistSession(runtime);
                    return;
                default:
                    return;
            }
        }

        if (inbound.type === "language") {
            runtime.snapshot.language = inbound.language;
            runtime.snapshot.updatedAt = new Date().toISOString();
            this.emit(runtime, "transcript.language", {
                language: inbound.language,
            });
            this.queuePersistSession(runtime);
            return;
        }

        if (inbound.type === "segments") {
            for (const segment of inbound.segments) {
                if (!runtime.segmentMap.has(segment.id)) {
                    runtime.segmentOrder.push(segment.id);
                    runtime.segmentSeqById.set(
                        segment.id,
                        runtime.segmentOrder.length,
                    );
                }
                runtime.segmentMap.set(segment.id, segment);
                const emitted = this.emit(runtime, "transcript.segment", {
                    segment,
                    text: segment.text,
                });
                const segmentSeq = runtime.segmentSeqById.get(segment.id) ?? 0;
                this.queuePersistSegment(
                    runtime,
                    emitted.seq,
                    segmentSeq,
                    segment,
                );
            }

            runtime.snapshot.transcriptSegments = runtime.segmentOrder
                .map((id) => runtime.segmentMap.get(id))
                .filter(
                    (
                        segment,
                    ): segment is LiveSessionSnapshot["transcriptSegments"][number] =>
                        Boolean(segment),
                );
            runtime.snapshot.transcriptText =
                runtime.snapshot.transcriptSegments
                    .map((segment) => segment.text)
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim();
            runtime.snapshot.updatedAt = new Date().toISOString();

            if (
                runtime.snapshot.status === "ready" ||
                runtime.snapshot.status === "initializing"
            ) {
                runtime.snapshot.status = "streaming";
            }

            this.queuePersistSession(runtime);
        }
    }

    private emit(
        runtime: LiveRuntimeSession,
        type: LiveEvent["type"],
        overrides?: Partial<
            Pick<LiveEvent, "text" | "language" | "segment" | "warning">
        >,
    ): LiveEvent {
        const seq = runtime.nextSeq++;
        const event: LiveEvent = {
            id: `${runtime.id}:${seq}`,
            seq,
            sessionId: runtime.id,
            type,
            at: new Date().toISOString(),
            status: runtime.snapshot.status,
            text: overrides?.text,
            language: overrides?.language,
            segment: overrides?.segment,
            warning: overrides?.warning,
            error: runtime.snapshot.error ?? undefined,
        };

        runtime.events.push(event);
        const maxEvents = getLiveRuntimeEnvironment().eventBufferSize;
        if (runtime.events.length > maxEvents) {
            runtime.events.splice(0, runtime.events.length - maxEvents);
        }

        liveEventBus.publish(event);
        return event;
    }

    private flushPendingAudio(runtime: LiveRuntimeSession): void {
        if (!runtime.adapter?.isOpen()) return;
        if (runtime.sentChunkCount >= runtime.audioChunks.length) return;

        for (
            let index = runtime.sentChunkCount;
            index < runtime.audioChunks.length;
            index++
        ) {
            const chunk = runtime.audioChunks[index];
            try {
                runtime.adapter.sendChunk(chunk);
                runtime.sentChunkCount = index + 1;
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : "Failed to forward buffered audio chunk";
                this.setError(runtime, "provider-unavailable", message);
                return;
            }
        }
    }

    private setError(
        runtime: LiveRuntimeSession,
        code: LiveErrorCode,
        message: string,
    ): void {
        runtime.snapshot.status = "error";
        runtime.snapshot.error = {
            code,
            message,
            retryable:
                code === "provider-error" || code === "provider-unavailable",
        };
        runtime.snapshot.updatedAt = new Date().toISOString();
        this.emit(runtime, "session.error");
        this.queuePersistSession(runtime);
    }

    private createReadStateFromRuntime(
        runtime: LiveRuntimeSession,
    ): LiveSessionReadState {
        return {
            snapshot: runtime.snapshot,
            isActive: this.isSessionActive(runtime.snapshot),
            lastSeq: Math.max(0, runtime.nextSeq - 1),
        };
    }

    private isSessionActive(snapshot: LiveSessionSnapshot): boolean {
        return (
            snapshot.status === "initializing" ||
            snapshot.status === "ready" ||
            snapshot.status === "streaming" ||
            snapshot.status === "stopping" ||
            snapshot.status === "finalizing"
        );
    }

    private async runFinalize(
        runtime: LiveRuntimeSession,
        request: FinalizeLiveTranscriptionRequest | undefined,
    ): Promise<{ snapshot: LiveSessionSnapshot; recordingId: string | null }> {
        runtime.snapshot.status = "finalizing";
        runtime.snapshot.updatedAt = new Date().toISOString();
        runtime.adapter?.close();
        await this.persistSession(runtime);

        const finalizedAt = new Date();
        const result = await persistFinalizedLiveSession({
            sessionId: runtime.id,
            userId: runtime.userId,
            createdAt: new Date(runtime.snapshot.createdAt),
            finalizedAt,
            title:
                typeof request?.title === "string" && request.title.trim()
                    ? request.title.trim()
                    : null,
            transcriptText: runtime.snapshot.transcriptText,
            language: runtime.snapshot.language,
            config: runtime.snapshot.config,
            audioChunks: runtime.audioChunks,
            autoSummary: request?.autoSummary === true,
        });

        runtime.snapshot.status = "finalized";
        runtime.snapshot.finalizedAt = finalizedAt.toISOString();
        runtime.snapshot.stoppedAt =
            runtime.snapshot.stoppedAt ?? finalizedAt.toISOString();
        runtime.snapshot.updatedAt = finalizedAt.toISOString();
        runtime.snapshot.recordingId = result.recordingId;
        runtime.snapshot.transcriptionId = result.transcriptionId;

        this.emit(runtime, "session.finalized");
        await this.persistSession(runtime);
        this.scheduleCleanup(runtime);

        return {
            snapshot: runtime.snapshot,
            recordingId: result.recordingId,
        };
    }

    private async persistSession(runtime: LiveRuntimeSession): Promise<void> {
        await persistLiveSessionState({
            sessionId: runtime.id,
            userId: runtime.userId,
            snapshot: runtime.snapshot,
            lastSeq: runtime.nextSeq - 1,
        });
    }

    private queuePersistSession(runtime: LiveRuntimeSession): void {
        void this.persistSession(runtime).catch((error) => {
            console.error(
                "Failed to persist live transcription session state:",
                error,
            );
        });
    }

    private queuePersistSegment(
        runtime: LiveRuntimeSession,
        seq: number,
        segmentSeq: number,
        segment: LiveSessionSnapshot["transcriptSegments"][number],
    ): void {
        if (segmentSeq <= 0) {
            return;
        }

        void persistLiveSegment({
            sessionId: runtime.id,
            userId: runtime.userId,
            seq,
            segmentSeq,
            segment,
            language: runtime.snapshot.language,
        }).catch((error) => {
            console.error(
                "Failed to persist live transcription segment update:",
                error,
            );
        });
    }

    private lookupSession(sessionId: string, userId: string): SessionLookup {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
            throw new LiveSessionError(
                "not-found",
                "Live transcription session not found",
                404,
            );
        }
        if (runtime.userId !== userId) {
            throw new LiveSessionError(
                "forbidden",
                "You do not have access to this live session",
                403,
            );
        }

        this.ensureNotExpired(runtime, true);
        return { runtime };
    }

    private ensureNotExpired(
        runtime: LiveRuntimeSession,
        allowExpiredSessionRead = false,
    ): void {
        if (runtime.snapshot.status === "finalized") {
            return;
        }

        if (runtime.snapshot.status === "expired") {
            if (!allowExpiredSessionRead) {
                throw new LiveSessionError(
                    "session-expired",
                    "Live transcription session exceeded max duration",
                    410,
                );
            }
            return;
        }

        const expiresAtMs = new Date(runtime.snapshot.expiresAt).getTime();
        if (Date.now() <= expiresAtMs) return;

        runtime.snapshot.status = "expired";
        runtime.snapshot.stoppedAt =
            runtime.snapshot.stoppedAt ?? new Date().toISOString();
        runtime.snapshot.updatedAt = runtime.snapshot.stoppedAt;
        runtime.snapshot.error = {
            code: "session-expired",
            message: "Live transcription session exceeded max duration",
            retryable: false,
        };
        runtime.adapter?.close();
        this.emit(runtime, "session.error");
        this.queuePersistSession(runtime);
        this.scheduleCleanup(runtime);

        if (!allowExpiredSessionRead) {
            throw new LiveSessionError(
                "session-expired",
                "Live transcription session exceeded max duration",
                410,
            );
        }
    }

    private scheduleCleanup(runtime: LiveRuntimeSession): void {
        if (runtime.cleanupTimer) {
            clearTimeout(runtime.cleanupTimer);
            runtime.cleanupTimer = null;
        }

        const retentionMinutes =
            getLiveRuntimeEnvironment().sessionRetentionMinutes;
        const delayMs = retentionMinutes * 60 * 1000;
        runtime.cleanupTimer = setTimeout(() => {
            this.sessions.delete(runtime.id);
        }, delayMs);
    }
}

export const liveRuntimeRegistry = new LiveRuntimeRegistry();

export function getSessionDurationMs(snapshot: LiveSessionSnapshot): number {
    return calculateDurationMs(snapshot.audioSampleCount, 16000);
}
