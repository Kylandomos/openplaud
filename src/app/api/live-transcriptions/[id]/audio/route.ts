import { NextResponse } from "next/server";
import {
    float32ChunkFromArrayBuffer,
    parseFloat32ChunkBody,
} from "@/lib/live-transcription/audio";
import { liveRuntimeRegistry } from "@/lib/live-transcription/runtime-registry";
import { liveErrorResponse, requireLiveUser } from "../../_common";

export const runtime = "nodejs";

function readContentLength(request: Request): number | null {
    const raw = request.headers.get("content-length");
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = await requireLiveUser(request);
    if (context instanceof NextResponse) {
        return context;
    }

    try {
        const { id } = await params;
        const currentSession = await liveRuntimeRegistry.getSessionSnapshotForRead(
            id,
            context.userId,
        );
        const maxChunkBytes = currentSession.config.maxChunkBytes;

        const contentLength = readContentLength(request);
        if (contentLength !== null && contentLength > maxChunkBytes) {
            return NextResponse.json(
                {
                    error: "Audio chunk exceeds max payload size",
                    code: "payload-too-large",
                    maxChunkBytes,
                },
                { status: 413 },
            );
        }

        const contentType = request.headers.get("content-type") || "";
        let chunk: Float32Array | null = null;

        if (contentType.includes("application/json")) {
            const body = await request.json().catch(() => ({}));
            chunk = parseFloat32ChunkBody(body);
        } else {
            const rawBuffer = await request.arrayBuffer();
            if (rawBuffer.byteLength > maxChunkBytes) {
                return NextResponse.json(
                    {
                        error: "Audio chunk exceeds max payload size",
                        code: "payload-too-large",
                        maxChunkBytes,
                    },
                    { status: 413 },
                );
            }
            chunk = float32ChunkFromArrayBuffer(rawBuffer);
        }

        if (!chunk || chunk.length === 0) {
            return NextResponse.json(
                {
                    error: "Missing audio chunk",
                    code: "bad-request",
                },
                { status: 400 },
            );
        }

        if (chunk.byteLength > maxChunkBytes) {
            return NextResponse.json(
                {
                    error: "Audio chunk exceeds max payload size",
                    code: "payload-too-large",
                    maxChunkBytes,
                },
                { status: 413 },
            );
        }

        const session = liveRuntimeRegistry.appendAudioChunk(
            id,
            context.userId,
            chunk,
        );

        return NextResponse.json({
            session,
            acceptedBytes: chunk.byteLength,
        });
    } catch (error) {
        return liveErrorResponse(error);
    }
}
