import type {
    LiveSessionConfig,
    LiveTranscriptSegment,
} from "@/types/live-transcription";

type WhisperLiveStatus =
    | "WAIT"
    | "WARNING"
    | "ERROR"
    | "SERVER_READY"
    | "DISCONNECT";

export type WhisperLiveInboundEvent =
    | {
          type: "status";
          status: WhisperLiveStatus;
          message: string | null;
      }
    | {
          type: "language";
          language: string;
      }
    | {
          type: "segments";
          segments: LiveTranscriptSegment[];
      };

export interface WhisperLiveAdapterOptions {
    wsUrl: string;
    uid: string;
    config: Pick<LiveSessionConfig, "language" | "model" | "task" | "useVad">;
    onOpen: () => void;
    onClose: () => void;
    onError: (message: string) => void;
    onInbound: (event: WhisperLiveInboundEvent) => void;
}

export interface WhisperLiveAdapter {
    sendChunk: (chunk: Float32Array) => void;
    close: () => void;
    isOpen: () => boolean;
}

function readString(data: unknown): Promise<string | null> {
    if (typeof data === "string") {
        return Promise.resolve(data);
    }
    if (data instanceof ArrayBuffer) {
        return Promise.resolve(new TextDecoder().decode(new Uint8Array(data)));
    }
    if (ArrayBuffer.isView(data)) {
        return Promise.resolve(
            new TextDecoder().decode(
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            ),
        );
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
        return data.text();
    }
    return Promise.resolve(null);
}

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object") return null;
    return value as Record<string, unknown>;
}

function parseStatusFromPayload(payload: Record<string, unknown>): {
    status: WhisperLiveStatus;
    message: string | null;
} | null {
    const candidates = [
        payload.status,
        payload.event,
        payload.type,
        payload.message,
    ]
        .filter((value) => typeof value === "string")
        .map((value) => (value as string).toUpperCase());

    for (const candidate of candidates) {
        if (
            candidate === "WAIT" ||
            candidate === "WARNING" ||
            candidate === "ERROR" ||
            candidate === "SERVER_READY" ||
            candidate === "DISCONNECT"
        ) {
            return {
                status: candidate,
                message:
                    typeof payload.message === "string"
                        ? payload.message
                        : null,
            };
        }
    }

    return null;
}

function parseSegments(
    payload: Record<string, unknown>,
): LiveTranscriptSegment[] {
    const list = Array.isArray(payload.segments)
        ? payload.segments
        : Array.isArray(payload.segment)
          ? payload.segment
          : [];

    return list
        .map((entry, index) => {
            const row = asObject(entry);
            if (!row) return null;

            const text =
                typeof row.text === "string"
                    ? row.text.trim()
                    : typeof row.segment === "string"
                      ? row.segment.trim()
                      : "";
            if (!text) return null;

            const startRaw =
                typeof row.start === "number"
                    ? row.start
                    : typeof row.start_time === "number"
                      ? row.start_time
                      : null;
            const endRaw =
                typeof row.end === "number"
                    ? row.end
                    : typeof row.end_time === "number"
                      ? row.end_time
                      : null;
            const finalRaw =
                typeof row.is_final === "boolean"
                    ? row.is_final
                    : typeof row.final === "boolean"
                      ? row.final
                      : true;

            return {
                id:
                    typeof row.id === "string" && row.id.trim()
                        ? row.id
                        : `segment-${Date.now()}-${index}`,
                text,
                startSec: startRaw,
                endSec: endRaw,
                isFinal: finalRaw,
            } satisfies LiveTranscriptSegment;
        })
        .filter(
            (segment): segment is LiveTranscriptSegment => segment !== null,
        );
}

function parseInbound(text: string): WhisperLiveInboundEvent | null {
    const normalized = text.trim();
    if (!normalized) return null;

    try {
        const parsed = JSON.parse(normalized) as unknown;
        const payload = asObject(parsed);
        if (!payload) return null;

        const statusPayload = parseStatusFromPayload(payload);
        if (statusPayload) {
            return {
                type: "status",
                status: statusPayload.status,
                message: statusPayload.message,
            };
        }

        if (typeof payload.language === "string" && payload.language.trim()) {
            return {
                type: "language",
                language: payload.language.trim(),
            };
        }

        const segments = parseSegments(payload);
        if (segments.length > 0) {
            return {
                type: "segments",
                segments,
            };
        }

        return null;
    } catch {
        const upper = normalized.toUpperCase();
        if (
            upper === "WAIT" ||
            upper === "WARNING" ||
            upper === "ERROR" ||
            upper === "SERVER_READY" ||
            upper === "DISCONNECT"
        ) {
            return {
                type: "status",
                status: upper,
                message: null,
            };
        }
        return null;
    }
}

export function createWhisperLiveAdapter(
    options: WhisperLiveAdapterOptions,
): WhisperLiveAdapter {
    const ws = new WebSocket(options.wsUrl);

    ws.addEventListener("open", () => {
        const initMessage = {
            uid: options.uid,
            language: options.config.language,
            model: options.config.model,
            task: options.config.task,
            use_vad: options.config.useVad,
        };

        ws.send(JSON.stringify(initMessage));
        options.onOpen();
    });

    ws.addEventListener("message", (event) => {
        void readString(event.data)
            .then((text) => {
                if (!text) return;
                const parsed = parseInbound(text);
                if (parsed) {
                    options.onInbound(parsed);
                }
            })
            .catch((error) => {
                options.onError(
                    error instanceof Error
                        ? error.message
                        : "Failed to parse provider payload",
                );
            });
    });

    ws.addEventListener("error", () => {
        options.onError("WhisperLive websocket error");
    });

    ws.addEventListener("close", () => {
        options.onClose();
    });

    return {
        sendChunk(chunk) {
            if (ws.readyState !== WebSocket.OPEN) {
                throw new Error("WhisperLive websocket is not open");
            }
            const binary = new Uint8Array(
                chunk.buffer.slice(
                    chunk.byteOffset,
                    chunk.byteOffset + chunk.byteLength,
                ),
            );
            ws.send(binary);
        },
        close() {
            if (
                ws.readyState === WebSocket.OPEN ||
                ws.readyState === WebSocket.CONNECTING
            ) {
                ws.close(1000, "Session closed");
            }
        },
        isOpen() {
            return ws.readyState === WebSocket.OPEN;
        },
    };
}
