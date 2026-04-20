import { NextResponse } from "next/server";
import { liveRuntimeRegistry } from "@/lib/live-transcription/runtime-registry";
import type { CreateLiveTranscriptionRequest } from "@/types/live-transcription";
import { liveErrorResponse, requireLiveUser } from "./_common";

export const runtime = "nodejs";

export async function POST(request: Request) {
    const context = await requireLiveUser(request);
    if (context instanceof NextResponse) {
        return context;
    }

    try {
        const body = (await request.json().catch(() => ({}))) as
            | CreateLiveTranscriptionRequest
            | undefined;

        const session = await liveRuntimeRegistry.createSession(
            context.userId,
            body,
        );
        return NextResponse.json({
            id: session.id,
            sessionId: session.id,
            eventsUrl: `/api/live-transcriptions/${session.id}/events`,
            session,
            capabilities: liveRuntimeRegistry.getCapabilities(),
        });
    } catch (error) {
        console.error("Failed to create live transcription session:", error);
        return liveErrorResponse(error);
    }
}
