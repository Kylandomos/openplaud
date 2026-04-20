export type LiveProviderName = "whisperlive";
export type LiveTransportMode = "relay";

export type LiveTranscriptionStatus =
    | "initializing"
    | "ready"
    | "streaming"
    | "stopping"
    | "stopped"
    | "finalizing"
    | "finalized"
    | "expired"
    | "error";

export type LiveEventType =
    | "session.created"
    | "session.ready"
    | "session.warning"
    | "session.error"
    | "session.disconnected"
    | "session.stopped"
    | "session.finalized"
    | "transcript.language"
    | "transcript.segment";

export type LiveErrorCode =
    | "feature-disabled"
    | "unauthorized"
    | "forbidden"
    | "not-found"
    | "bad-request"
    | "payload-too-large"
    | "session-expired"
    | "provider-unavailable"
    | "provider-error"
    | "runtime-error";

export interface LiveError {
    code: LiveErrorCode;
    message: string;
    retryable?: boolean;
    details?: Record<string, string | number | boolean | null>;
}

export interface LiveProviderCapabilities {
    provider: LiveProviderName;
    transport: LiveTransportMode;
    supportsLanguage: boolean;
    supportsTask: boolean;
    supportsVad: boolean;
    inputSampleRate: number;
    inputChannels: number;
    inputEncoding: "float32-pcm";
}

export interface LiveSessionConfig {
    provider: LiveProviderName;
    transport: LiveTransportMode;
    language: string | null;
    model: string;
    task: "transcribe" | "translate";
    useVad: boolean;
    maxSessionMinutes: number;
    maxChunkBytes: number;
}

export interface LiveTranscriptSegment {
    id: string;
    text: string;
    startSec: number | null;
    endSec: number | null;
    isFinal: boolean;
}

export interface LiveEvent {
    id: string;
    seq: number;
    sessionId: string;
    type: LiveEventType;
    at: string;
    status: LiveTranscriptionStatus;
    text?: string;
    language?: string;
    segment?: LiveTranscriptSegment;
    warning?: string;
    error?: LiveError;
}

export interface LiveSessionSnapshot {
    id: string;
    status: LiveTranscriptionStatus;
    config: LiveSessionConfig;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    stoppedAt: string | null;
    finalizedAt: string | null;
    language: string | null;
    transcriptText: string;
    transcriptSegments: LiveTranscriptSegment[];
    audioBytesReceived: number;
    audioSampleCount: number;
    recordingId: string | null;
    transcriptionId: string | null;
    warning: string | null;
    error: LiveError | null;
}

export interface CreateLiveTranscriptionRequest {
    language?: string | null;
    model?: string;
    task?: "transcribe" | "translate";
    useVad?: boolean;
}

export interface CreateLiveTranscriptionResponse {
    session: LiveSessionSnapshot;
    capabilities: LiveProviderCapabilities;
}

export interface AppendLiveAudioRequest {
    chunk?: number[];
}

export interface StopLiveTranscriptionResponse {
    session: LiveSessionSnapshot;
}

export interface FinalizeLiveTranscriptionRequest {
    title?: string;
    autoSummary?: boolean;
}

export interface FinalizeLiveTranscriptionResponse {
    session: LiveSessionSnapshot;
    recordingId: string | null;
    transcriptionId: string | null;
}
