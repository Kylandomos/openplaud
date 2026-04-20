"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 16000;
const AUDIO_BUFFER_SIZE = 4096;

const ACTIVE_STATES = new Set<LiveTranscriptionState>([
    "requesting-microphone-permission",
    "connecting",
    "listening",
    "receiving-partial-transcript",
]);

type JsonRecord = Record<string, unknown>;
type BrowserWindow = Window &
    typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
    };

export type LiveTranscriptionState =
    | "idle"
    | "requesting-microphone-permission"
    | "connecting"
    | "listening"
    | "receiving-partial-transcript"
    | "stopped"
    | "saving"
    | "saved"
    | "error";

export interface LiveTranscriptSegment {
    id: string;
    text: string;
    seq: number;
    startMs?: number;
    endMs?: number;
    isFinal: boolean;
}

interface StartLiveTranscriptionOptions {
    language: string;
    model: string;
    autoSummary: boolean;
}

interface SaveLiveTranscriptionResult {
    success: boolean;
    recordingId?: string;
}

interface CreateSessionResponse {
    id?: string;
    sessionId?: string;
    eventsUrl?: string;
    session?: {
        id?: string;
    };
}

interface UseLiveTranscriptionResult {
    state: LiveTranscriptionState;
    sessionId: string | null;
    segments: LiveTranscriptSegment[];
    partialTranscript: string;
    finalTranscript: string;
    combinedTranscript: string;
    detectedLanguage: string | null;
    elapsedMs: number;
    isActive: boolean;
    isBusy: boolean;
    errorMessage: string | null;
    recordingId: string | null;
    start: (options: StartLiveTranscriptionOptions) => Promise<boolean>;
    stop: () => Promise<void>;
    save: (autoSummary: boolean) => Promise<SaveLiveTranscriptionResult>;
    discard: () => Promise<boolean>;
    reset: () => void;
    copyTranscript: () => Promise<boolean>;
}

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null;
}

function getString(
    source: JsonRecord,
    ...keys: string[]
): string | undefined {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
    }
    return undefined;
}

function getNumber(
    source: JsonRecord,
    ...keys: string[]
): number | undefined {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}

function normalizeLiveError(rawError: unknown, fallback: string): string {
    if (!rawError) return fallback;

    if (typeof rawError === "string") {
        return rawError;
    }

    if (rawError instanceof DOMException) {
        if (rawError.name === "NotAllowedError") {
            return "Microphone permission was denied. Allow microphone access and try again.";
        }

        if (rawError.name === "NotFoundError") {
            return "No microphone was detected. Connect a microphone and try again.";
        }

        if (rawError.name === "NotReadableError") {
            return "Microphone is currently in use by another app.";
        }
    }

    if (rawError instanceof Error && rawError.message) {
        return rawError.message;
    }

    return fallback;
}

async function parseJsonBody(response: Response): Promise<JsonRecord | null> {
    try {
        const json = await response.json();
        if (isJsonRecord(json)) {
            return json;
        }
        return null;
    } catch {
        return null;
    }
}

function mapResponseError(response: Response, payload: JsonRecord | null): string {
    const payloadMessage =
        (payload && getString(payload, "error", "message")) || undefined;
    const payloadCode = (payload && getString(payload, "errorCode", "code")) || "";

    if (response.status === 401 || response.status === 403) {
        return "Your session expired. Refresh and sign in again.";
    }

    if (response.status === 404 || response.status === 502 || response.status === 503) {
        return "Live transcription backend is unavailable right now.";
    }

    if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 410 ||
        response.status === 413 ||
        payloadCode.includes("SESSION_TOO_LONG")
    ) {
        return "This session reached the maximum allowed duration. Stop and save, then start a new one.";
    }

    return payloadMessage || "Request failed.";
}

function mixToMono(inputBuffer: AudioBuffer): Float32Array {
    const channelCount = inputBuffer.numberOfChannels;
    const frameCount = inputBuffer.length;

    if (channelCount === 1) {
        const mono = new Float32Array(frameCount);
        mono.set(inputBuffer.getChannelData(0));
        return mono;
    }

    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
        const channelData = inputBuffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i += 1) {
            mono[i] += channelData[i] / channelCount;
        }
    }
    return mono;
}

function resampleTo16k(input: Float32Array, inputSampleRate: number): Float32Array {
    if (inputSampleRate === TARGET_SAMPLE_RATE) {
        return input;
    }

    const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
    const outputLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i += 1) {
        const sourceIndex = i * ratio;
        const leftIndex = Math.floor(sourceIndex);
        const rightIndex = Math.min(leftIndex + 1, input.length - 1);
        const mix = sourceIndex - leftIndex;
        output[i] = input[leftIndex] * (1 - mix) + input[rightIndex] * mix;
    }

    return output;
}

function fallbackCopyText(text: string): boolean {
    try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const didCopy = document.execCommand("copy");
        document.body.removeChild(textarea);
        return didCopy;
    } catch {
        return false;
    }
}

export function useLiveTranscription(): UseLiveTranscriptionResult {
    const [state, setState] = useState<LiveTranscriptionState>("idle");
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [segments, setSegments] = useState<LiveTranscriptSegment[]>([]);
    const [partialTranscript, setPartialTranscript] = useState("");
    const [detectedLanguage, setDetectedLanguage] = useState<string | null>(
        null,
    );
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [recordingId, setRecordingId] = useState<string | null>(null);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const [stoppedAt, setStoppedAt] = useState<number | null>(null);

    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
    const silentGainRef = useRef<GainNode | null>(null);
    const eventSourceRef = useRef<EventSource | null>(null);
    const uploadSeqRef = useRef(0);
    const uploadChainRef = useRef<Promise<void>>(Promise.resolve());
    const isUnmountingRef = useRef(false);
    const hasTerminalErrorRef = useRef(false);

    const nextSegmentSeqRef = useRef(1);
    const segmentOrderRef = useRef<Map<number, LiveTranscriptSegment>>(new Map());
    const stateRef = useRef<LiveTranscriptionState>("idle");

    const finalTranscript = useMemo(
        () => segments.map((segment) => segment.text).join("\n"),
        [segments],
    );

    const combinedTranscript = useMemo(() => {
        const tail = partialTranscript.trim();
        if (!tail) return finalTranscript;
        if (!finalTranscript.trim()) return tail;
        return `${finalTranscript}\n${tail}`;
    }, [finalTranscript, partialTranscript]);

    const isActive = ACTIVE_STATES.has(state);
    const isBusy = state === "connecting" || state === "saving";

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    const closeEventStream = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }
    }, []);

    const stopAudioCapture = useCallback(() => {
        const processor = processorNodeRef.current;
        const sourceNode = sourceNodeRef.current;
        const silentGain = silentGainRef.current;
        const context = audioContextRef.current;
        const stream = streamRef.current;

        if (processor) {
            processor.onaudioprocess = null;
            processor.disconnect();
            processorNodeRef.current = null;
        }

        if (sourceNode) {
            sourceNode.disconnect();
            sourceNodeRef.current = null;
        }

        if (silentGain) {
            silentGain.disconnect();
            silentGainRef.current = null;
        }

        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
            streamRef.current = null;
        }

        if (context) {
            void context.close().catch(() => {});
            audioContextRef.current = null;
        }
    }, []);

    const clearTranscriptState = useCallback(() => {
        segmentOrderRef.current.clear();
        nextSegmentSeqRef.current = 1;
        setSegments([]);
        setPartialTranscript("");
        setDetectedLanguage(null);
    }, []);

    const reset = useCallback(() => {
        closeEventStream();
        stopAudioCapture();
        uploadSeqRef.current = 0;
        uploadChainRef.current = Promise.resolve();
        hasTerminalErrorRef.current = false;
        setSessionId(null);
        setRecordingId(null);
        setErrorMessage(null);
        setElapsedMs(0);
        setStartedAt(null);
        setStoppedAt(null);
        setState("idle");
        clearTranscriptState();
    }, [clearTranscriptState, closeEventStream, stopAudioCapture]);

    const setTerminalError = useCallback(
        (message: string) => {
            if (hasTerminalErrorRef.current) return;
            hasTerminalErrorRef.current = true;
            setErrorMessage(message);
            setState("error");
            setStoppedAt((prev) => prev ?? Date.now());
            stopAudioCapture();
            closeEventStream();
        },
        [closeEventStream, stopAudioCapture],
    );

    const upsertFinalSegment = useCallback((segment: LiveTranscriptSegment) => {
        segmentOrderRef.current.set(segment.seq, segment);
        const ordered = [...segmentOrderRef.current.entries()]
            .sort((a, b) => a[0] - b[0])
            .map((entry) => entry[1]);
        setSegments(ordered);
    }, []);

    const consumeEventPayload = useCallback(
        (payload: JsonRecord) => {
            const eventType =
                getString(payload, "type", "event", "name") || "message";
            const lowerEventType = eventType.toLowerCase();

            if (
                lowerEventType.includes("snapshot") &&
                isJsonRecord(payload.session)
            ) {
                const snapshot = payload.session;
                const snapshotLanguage = getString(
                    snapshot,
                    "language",
                    "detectedLanguage",
                );
                if (snapshotLanguage) {
                    setDetectedLanguage(snapshotLanguage);
                }

                const snapshotRecordingId = getString(snapshot, "recordingId");
                if (snapshotRecordingId) {
                    setRecordingId(snapshotRecordingId);
                }

                return;
            }

            const detected = getString(
                payload,
                "detectedLanguage",
                "language",
                "lang",
            );
            if (detected) {
                setDetectedLanguage(detected);
            }

            if (
                lowerEventType.includes("error") ||
                lowerEventType.includes("failed")
            ) {
                const serverMessage =
                    getString(payload, "message", "error") ||
                    "Live transcription failed.";
                const code = getString(payload, "errorCode", "code");
                if (code && code.includes("SESSION_TOO_LONG")) {
                    setTerminalError(
                        "This session reached the maximum allowed duration. Stop and save, then start a new one.",
                    );
                    return;
                }
                setTerminalError(serverMessage);
                return;
            }

            if (
                lowerEventType.includes("saved") ||
                lowerEventType.includes("session.saved")
            ) {
                setRecordingId(getString(payload, "recordingId") || null);
                setState("saved");
                setStoppedAt((prev) => prev ?? Date.now());
                return;
            }

            if (
                lowerEventType.includes("stopped") ||
                lowerEventType.includes("finalized")
            ) {
                setPartialTranscript("");
                setState("stopped");
                setStoppedAt((prev) => prev ?? Date.now());
                return;
            }

            if (
                lowerEventType.includes("connected") ||
                lowerEventType.includes("ready")
            ) {
                setState("listening");
                return;
            }

            const segmentPayload = isJsonRecord(payload.segment)
                ? payload.segment
                : payload;
            const text = getString(segmentPayload, "text", "transcript");
            if (!text) {
                return;
            }

            const explicitFinal = Boolean(
                segmentPayload.isFinal === true ||
                    payload.isFinal === true ||
                    lowerEventType.includes("final"),
            );

            if (!explicitFinal) {
                setPartialTranscript(text);
                const currentState = stateRef.current;
                if (
                    currentState === "listening" ||
                    currentState === "receiving-partial-transcript" ||
                    currentState === "connecting"
                ) {
                    setState("receiving-partial-transcript");
                }
                return;
            }

            const seq =
                getNumber(segmentPayload, "segmentSeq", "seq") ??
                getNumber(payload, "segmentSeq", "seq") ??
                nextSegmentSeqRef.current;

            nextSegmentSeqRef.current = Math.max(nextSegmentSeqRef.current, seq + 1);

            upsertFinalSegment({
                id: `${seq}`,
                text,
                seq,
                startMs:
                    getNumber(segmentPayload, "startMs") ??
                    getNumber(payload, "startMs"),
                endMs:
                    getNumber(segmentPayload, "endMs") ??
                    getNumber(payload, "endMs"),
                isFinal: true,
            });

            setPartialTranscript("");
            setState("listening");
        },
        [setTerminalError, upsertFinalSegment],
    );

    const attachEventStream = useCallback(
        (targetSessionId: string, explicitEventsUrl?: string) => {
            const eventsUrl =
                explicitEventsUrl ||
                `/api/live-transcriptions/${targetSessionId}/events`;
            const eventSource = new EventSource(eventsUrl);
            eventSourceRef.current = eventSource;

            eventSource.onopen = () => {
                setState((prev) =>
                    prev === "connecting" ? "listening" : prev,
                );
            };

            const handleServerEvent = (event: MessageEvent<string>) => {
                if (!event.data) return;
                try {
                    const payload = JSON.parse(event.data) as unknown;
                    if (isJsonRecord(payload)) {
                        consumeEventPayload(payload);
                    }
                } catch {
                    // Ignore non-JSON keepalive payloads.
                }
            };

            eventSource.onmessage = handleServerEvent;
            eventSource.addEventListener(
                "snapshot",
                handleServerEvent as EventListener,
            );
            eventSource.addEventListener(
                "event",
                handleServerEvent as EventListener,
            );

            eventSource.onerror = () => {
                const currentState = stateRef.current;
                if (isUnmountingRef.current || currentState === "saved") {
                    return;
                }

                if (currentState === "connecting") {
                    setTerminalError(
                        "Could not connect to the live transcription stream.",
                    );
                    return;
                }

                if (
                    currentState === "listening" ||
                    currentState === "receiving-partial-transcript"
                ) {
                    setTerminalError(
                        "Live transcription stream disconnected. Please save or discard this session.",
                    );
                }
            };
        },
        [consumeEventPayload, setTerminalError],
    );

    const postAudioChunk = useCallback(
        async (targetSessionId: string, chunk: Float32Array) => {
            const seq = uploadSeqRef.current;
            uploadSeqRef.current += 1;
            const payload = new ArrayBuffer(chunk.byteLength);
            new Float32Array(payload).set(chunk);

            const response = await fetch(
                `/api/live-transcriptions/${targetSessionId}/audio?seq=${seq}`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/octet-stream",
                        "X-Audio-Format": "f32le",
                        "X-Sample-Rate": `${TARGET_SAMPLE_RATE}`,
                        "X-Audio-Channels": "1",
                    },
                    body: payload,
                },
            );

            if (!response.ok) {
                const body = await parseJsonBody(response);
                throw new Error(mapResponseError(response, body));
            }
        },
        [],
    );

    const enqueueChunkUpload = useCallback(
        (targetSessionId: string, chunk: Float32Array) => {
            uploadChainRef.current = uploadChainRef.current
                .then(() => postAudioChunk(targetSessionId, chunk))
                .catch((error: unknown) => {
                    const message = normalizeLiveError(
                        error,
                        "Failed to stream microphone audio.",
                    );
                    setTerminalError(message);
                    throw error;
                });
        },
        [postAudioChunk, setTerminalError],
    );

    const setupAudioPipeline = useCallback(
        async (targetSessionId: string, stream: MediaStream) => {
            const browserWindow = window as BrowserWindow;
            const AudioContextClass =
                browserWindow.AudioContext || browserWindow.webkitAudioContext;
            if (!AudioContextClass) {
                throw new Error("This browser does not support Web Audio.");
            }

            const audioContext = new AudioContextClass();
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(
                AUDIO_BUFFER_SIZE,
                1,
                1,
            );
            const silentGain = audioContext.createGain();
            silentGain.gain.value = 0;

            processor.onaudioprocess = (event) => {
                if (!ACTIVE_STATES.has(stateRef.current)) {
                    return;
                }

                const mono = mixToMono(event.inputBuffer);
                const resampled = resampleTo16k(mono, event.inputBuffer.sampleRate);
                if (!resampled.length) return;

                const transferableChunk = new Float32Array(resampled.length);
                transferableChunk.set(resampled);
                enqueueChunkUpload(targetSessionId, transferableChunk);
            };

            source.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(audioContext.destination);

            audioContextRef.current = audioContext;
            sourceNodeRef.current = source;
            processorNodeRef.current = processor;
            silentGainRef.current = silentGain;
        },
        [enqueueChunkUpload],
    );

    const start = useCallback(
        async (options: StartLiveTranscriptionOptions) => {
            if (state === "saving") {
                return false;
            }

            if (
                typeof window === "undefined" ||
                (typeof window.AudioContext === "undefined" &&
                    typeof (window as BrowserWindow).webkitAudioContext ===
                        "undefined") ||
                typeof window.EventSource === "undefined" ||
                !navigator.mediaDevices?.getUserMedia
            ) {
                setState("error");
                setErrorMessage(
                    "Live transcription requires a modern browser with microphone and streaming support.",
                );
                return false;
            }

            reset();
            setState("requesting-microphone-permission");

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                });
                streamRef.current = stream;

                setState("connecting");

                const createResponse = await fetch("/api/live-transcriptions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        language: options.language,
                        model: options.model,
                        autoSummary: options.autoSummary,
                    }),
                });

                if (!createResponse.ok) {
                    const createBody = await parseJsonBody(createResponse);
                    throw new Error(mapResponseError(createResponse, createBody));
                }

                const created =
                    (await parseJsonBody(createResponse)) as CreateSessionResponse | null;
                const createdSessionId =
                    created?.sessionId || created?.id || created?.session?.id;

                if (!createdSessionId) {
                    throw new Error("Live session could not be created.");
                }

                hasTerminalErrorRef.current = false;
                setSessionId(createdSessionId);
                setStartedAt(Date.now());
                setStoppedAt(null);
                uploadSeqRef.current = 0;

                attachEventStream(createdSessionId, created?.eventsUrl);
                await setupAudioPipeline(createdSessionId, stream);
                setState("listening");
                return true;
            } catch (error: unknown) {
                const message = normalizeLiveError(
                    error,
                    "Unable to start live transcription.",
                );
                setTerminalError(message);
                return false;
            }
        },
        [attachEventStream, reset, setupAudioPipeline, setTerminalError, state],
    );

    const stop = useCallback(async () => {
        if (!sessionId || state === "idle" || state === "saved") {
            return;
        }

        stopAudioCapture();
        closeEventStream();

        try {
            await uploadChainRef.current.catch(() => {});
        } finally {
            uploadChainRef.current = Promise.resolve();
        }

        setStoppedAt((prev) => prev ?? Date.now());
        setState("stopped");

        try {
            await fetch(`/api/live-transcriptions/${sessionId}/stop`, {
                method: "POST",
            });
        } catch {
            // Stopping capture locally is enough for UX; server stop is best-effort.
        }
    }, [closeEventStream, sessionId, state, stopAudioCapture]);

    const save = useCallback(
        async (autoSummary: boolean) => {
            if (!sessionId) {
                return { success: false };
            }

            if (state !== "stopped" && state !== "error") {
                await stop();
            }

            setState("saving");
            setErrorMessage(null);

            try {
                const response = await fetch(
                    `/api/live-transcriptions/${sessionId}/finalize`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ autoSummary }),
                    },
                );

                if (!response.ok) {
                    const payload = await parseJsonBody(response);
                    const message = mapResponseError(response, payload);
                    setState("error");
                    setErrorMessage(
                        message || "Save failed. Please retry or discard.",
                    );
                    return { success: false };
                }

                const payload = await parseJsonBody(response);
                const nextRecordingId = payload
                    ? getString(payload, "recordingId")
                    : undefined;

                setRecordingId(nextRecordingId || null);
                setState("saved");
                setStoppedAt((prev) => prev ?? Date.now());
                return {
                    success: true,
                    recordingId: nextRecordingId,
                };
            } catch (error: unknown) {
                setState("error");
                setErrorMessage(
                    normalizeLiveError(
                        error,
                        "Save failed. Please retry or discard.",
                    ),
                );
                return { success: false };
            }
        },
        [sessionId, state, stop],
    );

    const discard = useCallback(async () => {
        if (!sessionId) {
            reset();
            return true;
        }

        stopAudioCapture();
        closeEventStream();

        try {
            const response = await fetch(`/api/live-transcriptions/${sessionId}`, {
                method: "DELETE",
            });
            if (!response.ok) {
                const payload = await parseJsonBody(response);
                setState("error");
                setErrorMessage(
                    mapResponseError(response, payload) ||
                        "Could not discard this session.",
                );
                return false;
            }
        } catch (error: unknown) {
            setState("error");
            setErrorMessage(
                normalizeLiveError(error, "Could not discard this session."),
            );
            return false;
        }

        reset();
        return true;
    }, [closeEventStream, reset, sessionId, stopAudioCapture]);

    const copyTranscript = useCallback(async () => {
        const text = combinedTranscript.trim();
        if (!text) return false;

        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                return fallbackCopyText(text);
            }
        }

        return fallbackCopyText(text);
    }, [combinedTranscript]);

    useEffect(() => {
        if (!startedAt) {
            setElapsedMs(0);
            return;
        }

        if (stoppedAt) {
            setElapsedMs(Math.max(0, stoppedAt - startedAt));
            return;
        }

        const updateElapsed = () => {
            setElapsedMs(Math.max(0, Date.now() - startedAt));
        };

        updateElapsed();
        const intervalId = window.setInterval(updateElapsed, 500);
        return () => window.clearInterval(intervalId);
    }, [startedAt, stoppedAt]);

    useEffect(() => {
        return () => {
            isUnmountingRef.current = true;
            closeEventStream();
            stopAudioCapture();
        };
    }, [closeEventStream, stopAudioCapture]);

    return {
        state,
        sessionId,
        segments,
        partialTranscript,
        finalTranscript,
        combinedTranscript,
        detectedLanguage,
        elapsedMs,
        isActive,
        isBusy,
        errorMessage,
        recordingId,
        start,
        stop,
        save,
        discard,
        reset,
        copyTranscript,
    };
}
