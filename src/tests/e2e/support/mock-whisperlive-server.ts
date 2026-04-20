import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TRANSCRIPT_TEXT = "Deterministic transcript from E2E whisper mock.";

interface WhisperMockServer {
    close: () => Promise<void>;
}

interface ConnectionState {
    buffer: Buffer;
    transcriptSent: boolean;
    languageSent: boolean;
}

interface WsFrame {
    opcode: number;
    payload: Buffer;
}

function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
    const payloadLength = payload.length;

    if (payloadLength < 126) {
        return Buffer.concat([
            Buffer.from([0x80 | opcode, payloadLength]),
            payload,
        ]);
    }

    if (payloadLength < 65536) {
        const header = Buffer.allocUnsafe(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(payloadLength, 2);
        return Buffer.concat([header, payload]);
    }

    const header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
    return Buffer.concat([header, payload]);
}

function sendJson(socket: Socket, payload: unknown): void {
    const frame = encodeServerFrame(0x1, Buffer.from(JSON.stringify(payload)));
    socket.write(frame);
}

function parseFrames(buffer: Buffer): { frames: WsFrame[]; remaining: Buffer } {
    const frames: WsFrame[] = [];
    let offset = 0;

    while (offset + 2 <= buffer.length) {
        const firstByte = buffer[offset];
        const secondByte = buffer[offset + 1];

        let payloadLength = secondByte & 0x7f;
        let cursor = offset + 2;

        if (payloadLength === 126) {
            if (cursor + 2 > buffer.length) break;
            payloadLength = buffer.readUInt16BE(cursor);
            cursor += 2;
        } else if (payloadLength === 127) {
            if (cursor + 8 > buffer.length) break;
            const bigLength = buffer.readBigUInt64BE(cursor);
            if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error("Frame too large for test websocket parser");
            }
            payloadLength = Number(bigLength);
            cursor += 8;
        }

        const isMasked = (secondByte & 0x80) === 0x80;
        let mask: Buffer | null = null;
        if (isMasked) {
            if (cursor + 4 > buffer.length) break;
            mask = buffer.subarray(cursor, cursor + 4);
            cursor += 4;
        }

        if (cursor + payloadLength > buffer.length) break;

        const payload = Buffer.from(
            buffer.subarray(cursor, cursor + payloadLength),
        );
        if (mask) {
            for (let index = 0; index < payload.length; index += 1) {
                payload[index] ^= mask[index % 4];
            }
        }

        frames.push({
            opcode: firstByte & 0x0f,
            payload,
        });

        offset = cursor + payloadLength;
    }

    return {
        frames,
        remaining: buffer.subarray(offset),
    };
}

function onClientFrame(
    frame: WsFrame,
    socket: Socket,
    state: ConnectionState,
): void {
    if (frame.opcode === 0x8) {
        socket.write(encodeServerFrame(0x8, Buffer.alloc(0)));
        socket.end();
        return;
    }

    // Text frame is the provider init payload from the relay.
    if (frame.opcode === 0x1) {
        return;
    }

    // Binary frames are streamed microphone chunks from the relay.
    if (frame.opcode !== 0x2) {
        return;
    }

    if (!state.languageSent) {
        sendJson(socket, { language: "en" });
        state.languageSent = true;
    }

    if (state.transcriptSent) {
        return;
    }

    sendJson(socket, {
        segments: [
            {
                id: "segment-1",
                text: TRANSCRIPT_TEXT,
                start: 0,
                end: 0.9,
                is_final: true,
            },
        ],
    });
    state.transcriptSent = true;
}

function buildHandshakeAccept(key: string): string {
    return createHash("sha1").update(`${key}${WS_MAGIC_GUID}`).digest("base64");
}

export async function startMockWhisperLiveServer(
    port: number,
): Promise<WhisperMockServer> {
    const sockets = new Set<Socket>();
    const server: Server = createServer();

    server.on("upgrade", (request, socket) => {
        const websocket = socket as Socket;
        const websocketKey = request.headers["sec-websocket-key"];
        if (!websocketKey || Array.isArray(websocketKey)) {
            websocket.destroy();
            return;
        }

        const accept = buildHandshakeAccept(websocketKey);
        websocket.write(
            [
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${accept}`,
                "\r\n",
            ].join("\r\n"),
        );

        const state: ConnectionState = {
            buffer: Buffer.alloc(0),
            transcriptSent: false,
            languageSent: false,
        };

        sockets.add(websocket);
        websocket.on("close", () => {
            sockets.delete(websocket);
        });
        websocket.on("error", () => {
            sockets.delete(websocket);
        });

        sendJson(websocket, { status: "SERVER_READY", message: "ready" });

        websocket.on("data", (chunk) => {
            state.buffer = Buffer.concat([state.buffer, chunk]);
            const { frames, remaining } = parseFrames(state.buffer);
            state.buffer = remaining;

            for (const frame of frames) {
                onClientFrame(frame, websocket, state);
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });

    return {
        close: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) {
                    socket.destroy();
                }
                sockets.clear();
                server.close(() => resolve());
            }),
    };
}
