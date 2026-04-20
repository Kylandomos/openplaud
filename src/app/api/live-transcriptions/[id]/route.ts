import { NextResponse } from "next/server";
import {
    getSessionDurationMs,
    liveRuntimeRegistry,
} from "@/lib/live-transcription/runtime-registry";
import { liveErrorResponse, requireLiveUser } from "../_common";

export const runtime = "nodejs";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = await requireLiveUser(request);
    if (context instanceof NextResponse) {
        return context;
    }

    try {
        const { id } = await params;
        const session = await liveRuntimeRegistry.getSessionSnapshotForRead(
            id,
            context.userId,
        );
        return NextResponse.json({
            session,
            durationMs: getSessionDurationMs(session),
        });
    } catch (error) {
        return liveErrorResponse(error);
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = await requireLiveUser(request);
    if (context instanceof NextResponse) {
        return context;
    }

    try {
        const { id } = await params;
        await liveRuntimeRegistry.discardSession(id, context.userId);
        return NextResponse.json({ ok: true, discarded: true });
    } catch (error) {
        return liveErrorResponse(error);
    }
}
