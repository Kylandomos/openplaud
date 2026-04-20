import { NextResponse } from "next/server";
import { liveRuntimeRegistry } from "@/lib/live-transcription/runtime-registry";
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
        const session = liveRuntimeRegistry.stopSession(id, context.userId);
        return NextResponse.json({ session });
    } catch (error) {
        return liveErrorResponse(error);
    }
}
