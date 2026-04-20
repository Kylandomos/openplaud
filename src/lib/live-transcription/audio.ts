import { Buffer } from "node:buffer";

const PCM16_MAX = 32767;
const PCM16_MIN = -32768;

export interface WavBuildResult {
    wavBuffer: Buffer;
    sampleCount: number;
    durationMs: number;
}

export function parseFloat32ChunkBody(payload: unknown): Float32Array | null {
    if (!payload || typeof payload !== "object") return null;

    const record = payload as { chunk?: unknown };
    if (!Array.isArray(record.chunk) || record.chunk.length === 0) {
        return null;
    }

    const output = new Float32Array(record.chunk.length);
    for (let index = 0; index < record.chunk.length; index++) {
        const value = Number(record.chunk[index]);
        if (!Number.isFinite(value)) {
            throw new Error("Audio chunk contains non-finite values");
        }
        output[index] = value;
    }
    return output;
}

export function float32ChunkFromArrayBuffer(buffer: ArrayBuffer): Float32Array {
    if (buffer.byteLength === 0) {
        return new Float32Array(0);
    }
    if (buffer.byteLength % 4 !== 0) {
        throw new Error("Float32 audio payload must be 4-byte aligned");
    }
    return new Float32Array(buffer.slice(0));
}

export function calculateDurationMs(
    sampleCount: number,
    sampleRate: number,
): number {
    if (sampleCount <= 0 || sampleRate <= 0) return 0;
    return Math.round((sampleCount / sampleRate) * 1000);
}

export function buildWavFromFloat32Chunks(
    chunks: Float32Array[],
    sampleRate: number,
    channels = 1,
): WavBuildResult | null {
    const sampleCount = chunks.reduce(
        (total, chunk) => total + chunk.length,
        0,
    );
    if (sampleCount === 0) return null;

    const pcmData = new Int16Array(sampleCount);
    let writeOffset = 0;

    for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i++) {
            const normalized = Math.max(-1, Math.min(1, chunk[i]));
            const scaled =
                normalized < 0
                    ? Math.round(normalized * -PCM16_MIN)
                    : Math.round(normalized * PCM16_MAX);
            pcmData[writeOffset] = Math.max(
                PCM16_MIN,
                Math.min(PCM16_MAX, scaled),
            );
            writeOffset++;
        }
    }

    const bytesPerSample = 2;
    const byteRate = sampleRate * channels * bytesPerSample;
    const blockAlign = channels * bytesPerSample;
    const dataSize = pcmData.length * bytesPerSample;
    const fileSize = 44 + dataSize;

    const header = Buffer.allocUnsafe(44);
    header.write("RIFF", 0, 4, "ascii");
    header.writeUInt32LE(fileSize - 8, 4);
    header.write("WAVE", 8, 4, "ascii");
    header.write("fmt ", 12, 4, "ascii");
    header.writeUInt32LE(16, 16); // PCM format chunk size
    header.writeUInt16LE(1, 20); // Audio format PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36, 4, "ascii");
    header.writeUInt32LE(dataSize, 40);

    const pcmBuffer = Buffer.allocUnsafe(dataSize);
    for (let i = 0; i < pcmData.length; i++) {
        pcmBuffer.writeInt16LE(pcmData[i], i * 2);
    }

    return {
        wavBuffer: Buffer.concat([header, pcmBuffer]),
        sampleCount,
        durationMs: calculateDurationMs(sampleCount, sampleRate),
    };
}
