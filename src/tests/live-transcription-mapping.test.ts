import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    buildWavFromFloat32Chunks,
    float32ChunkFromArrayBuffer,
    parseFloat32ChunkBody,
} from "@/lib/live-transcription/audio";
import {
    createWhisperLiveAdapter,
    type WhisperLiveInboundEvent,
} from "@/lib/live-transcription/whisperlive-adapter";

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    readonly url: string;
    readyState = FakeWebSocket.CONNECTING;
    sent: unknown[] = [];
    closeArgs: { code?: number; reason?: string } | null = null;

    private listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    send(payload: unknown): void {
        this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
        this.closeArgs = { code, reason };
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("close", {});
    }

    open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open", {});
    }

    message(data: unknown): void {
        this.emit("message", { data });
    }

    error(): void {
        this.emit("error", {});
    }

    private emit(type: string, event: unknown): void {
        const list = this.listeners.get(type) ?? [];
        for (const listener of list) {
            listener(event);
        }
    }
}

describe("Live Transcription Mapping", () => {
    const originalWebSocket = globalThis.WebSocket;

    beforeEach(() => {
        FakeWebSocket.instances.length = 0;
        Object.assign(globalThis, {
            WebSocket: FakeWebSocket as unknown as typeof WebSocket,
        });
    });

    afterEach(() => {
        Object.assign(globalThis, { WebSocket: originalWebSocket });
    });

    it("maps raw WhisperLive payloads to normalized inbound events", async () => {
        const inbound: WhisperLiveInboundEvent[] = [];
        const onOpen = vi.fn();
        const onClose = vi.fn();
        const onError = vi.fn();

        createWhisperLiveAdapter({
            wsUrl: "ws://localhost:9090",
            uid: "session-1",
            config: {
                language: null,
                model: "small",
                task: "transcribe",
                useVad: true,
            },
            onOpen,
            onClose,
            onError,
            onInbound: (event) => inbound.push(event),
        });

        const ws = FakeWebSocket.instances[0];
        ws.open();
        ws.message("WAIT");
        ws.message(JSON.stringify({ language: " fr " }));
        ws.message(
            JSON.stringify({
                segments: [
                    {
                        id: "seg-1",
                        text: " hello ",
                        start_time: 0.1,
                        end_time: 0.9,
                        final: false,
                    },
                ],
            }),
        );

        await Promise.resolve();

        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();

        expect(JSON.parse(ws.sent[0] as string)).toEqual({
            uid: "session-1",
            language: null,
            model: "small",
            task: "transcribe",
            use_vad: true,
        });

        expect(inbound).toEqual([
            { type: "status", status: "WAIT", message: null },
            { type: "language", language: "fr" },
            {
                type: "segments",
                segments: [
                    {
                        id: "seg-1",
                        text: "hello",
                        startSec: 0.1,
                        endSec: 0.9,
                        isFinal: false,
                    },
                ],
            },
        ]);
    });

    it("sends binary chunks when open and rejects sends when closed", () => {
        const adapter = createWhisperLiveAdapter({
            wsUrl: "ws://localhost:9090",
            uid: "session-2",
            config: {
                language: "en",
                model: "small",
                task: "transcribe",
                useVad: true,
            },
            onOpen: vi.fn(),
            onClose: vi.fn(),
            onError: vi.fn(),
            onInbound: vi.fn(),
        });

        const ws = FakeWebSocket.instances[0];
        ws.open();

        adapter.sendChunk(new Float32Array([0.2, -0.2]));

        expect(ws.sent[1]).toBeInstanceOf(Uint8Array);
        expect((ws.sent[1] as Uint8Array).byteLength).toBe(8);

        ws.readyState = FakeWebSocket.CONNECTING;
        expect(() => adapter.sendChunk(new Float32Array([0.1]))).toThrow(
            "WhisperLive websocket is not open",
        );

        adapter.close();
        expect(ws.closeArgs).toEqual({ code: 1000, reason: "Session closed" });
    });

    it("converts and validates audio helper payloads", () => {
        expect(parseFloat32ChunkBody({ chunk: [0, 0.5, -1] })).toEqual(
            new Float32Array([0, 0.5, -1]),
        );
        expect(() => parseFloat32ChunkBody({ chunk: [1, Number.NaN] })).toThrow(
            "Audio chunk contains non-finite values",
        );
        expect(() => float32ChunkFromArrayBuffer(new ArrayBuffer(3))).toThrow(
            "Float32 audio payload must be 4-byte aligned",
        );
    });

    it("builds WAV output only when real audio samples exist", () => {
        expect(buildWavFromFloat32Chunks([], 16000, 1)).toBeNull();

        const built = buildWavFromFloat32Chunks(
            [new Float32Array([0, 0.5, -0.5, 1])],
            16000,
            1,
        );

        expect(built).not.toBeNull();
        expect(built?.sampleCount).toBe(4);
        expect(built?.durationMs).toBe(0);
        expect(built?.wavBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(built?.wavBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
    });
});
