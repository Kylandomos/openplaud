import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getFeatureDisabledError } from "@/lib/live-transcription/config";
import { LiveSessionError } from "@/lib/live-transcription/runtime-registry";

export const runtime = "nodejs";

export async function requireLiveUser(
    request: Request,
): Promise<{ userId: string } | NextResponse> {
    const featureDisabled = getFeatureDisabledError();
    if (featureDisabled) {
        return NextResponse.json(
            {
                error: featureDisabled.message,
                code: featureDisabled.code,
                details: featureDisabled.details,
            },
            { status: 503 },
        );
    }

    const session = await auth.api.getSession({
        headers: request.headers,
    });
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return { userId: session.user.id };
}

export function liveErrorResponse(error: unknown): NextResponse {
    if (
        error instanceof LiveSessionError ||
        (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            "httpStatus" in error &&
            typeof (error as { code?: unknown }).code === "string" &&
            typeof (error as { httpStatus?: unknown }).httpStatus === "number")
    ) {
        const liveError = error as {
            message: string;
            code: string;
            details?: Record<string, string | number | boolean | null>;
            httpStatus: number;
        };
        return NextResponse.json(
            {
                error: liveError.message,
                code: liveError.code,
                details: liveError.details,
            },
            { status: liveError.httpStatus },
        );
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
        {
            error: message,
            code: "runtime-error",
        },
        { status: 500 },
    );
}
