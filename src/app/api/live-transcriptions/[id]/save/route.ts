import { NextResponse } from "next/server";
import { liveRuntimeRegistry } from "@/lib/live-transcription/runtime-registry";
import type { FinalizeLiveTranscriptionRequest } from "@/types/live-transcription";
import { liveErrorResponse, requireLiveUser } from "../../_common";

export const runtime = "nodejs";

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
        const body = (await request.json().catch(() => ({}))) as
            | FinalizeLiveTranscriptionRequest
            | undefined;

        const { snapshot } = await liveRuntimeRegistry.finalizeSession(
            id,
            context.userId,
            body,
        );

        return NextResponse.json({
            session: snapshot,
            recordingId: snapshot.recordingId,
            transcriptionId: snapshot.transcriptionId,
        });
    } catch (error) {
        return liveErrorResponse(error);
    }
}
