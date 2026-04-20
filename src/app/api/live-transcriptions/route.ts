import { NextResponse } from "next/server";
import { liveRuntimeRegistry } from "@/lib/live-transcription/runtime-registry";
import type {
    CreateLiveTranscriptionRequest,
    LiveTranscriptionStatus,
} from "@/types/live-transcription";
import { liveErrorResponse, requireLiveUser } from "./_common";

export const runtime = "nodejs";

const DEFAULT_HISTORY_PAGE_SIZE = 20;
const MAX_HISTORY_PAGE_SIZE = 50;

interface DecodedHistoryCursor {
    createdAt: Date;
    id: string;
}

const HISTORY_STATUSES: ReadonlySet<LiveTranscriptionStatus> = new Set([
    "initializing",
    "ready",
    "streaming",
    "stopping",
    "stopped",
    "finalizing",
    "finalized",
    "expired",
    "error",
]);

function parseHistoryPageSize(searchParams: URLSearchParams): number {
    const raw = searchParams.get("limit");
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_HISTORY_PAGE_SIZE;
    }
    return Math.min(MAX_HISTORY_PAGE_SIZE, parsed);
}

function decodeHistoryCursor(raw: string | null): DecodedHistoryCursor | null {
    if (!raw) {
        return null;
    }

    try {
        const decoded = Buffer.from(raw, "base64url").toString("utf8");
        const parsed = JSON.parse(decoded) as {
            createdAt?: string;
            id?: string;
        };
        if (
            typeof parsed.createdAt !== "string" ||
            typeof parsed.id !== "string" ||
            !parsed.id.trim()
        ) {
            return null;
        }

        const createdAt = new Date(parsed.createdAt);
        if (Number.isNaN(createdAt.getTime())) {
            return null;
        }

        return {
            createdAt,
            id: parsed.id,
        };
    } catch {
        return null;
    }
}

function encodeHistoryCursor(cursor: {
    createdAt: string;
    id: string;
}): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseHistoryStatus(
    searchParams: URLSearchParams,
): LiveTranscriptionStatus | null | "invalid" {
    const raw = searchParams.get("status");
    if (!raw) {
        return null;
    }

    if (HISTORY_STATUSES.has(raw as LiveTranscriptionStatus)) {
        return raw as LiveTranscriptionStatus;
    }

    return "invalid";
}

export async function GET(request: Request) {
    const context = await requireLiveUser(request);
    if (context instanceof NextResponse) {
        return context;
    }

    try {
        const url = new URL(request.url);
        const limit = parseHistoryPageSize(url.searchParams);
        const cursor = decodeHistoryCursor(url.searchParams.get("cursor"));
        const status = parseHistoryStatus(url.searchParams);

        if (status === "invalid") {
            return NextResponse.json(
                {
                    error: "Invalid status filter",
                    code: "bad-request",
                },
                { status: 400 },
            );
        }

        const history = await liveRuntimeRegistry.listSessionHistoryForRead(
            context.userId,
            {
                limit,
                cursor,
                status,
            },
        );

        return NextResponse.json({
            items: history.items,
            nextCursor: history.nextCursor
                ? encodeHistoryCursor(history.nextCursor)
                : null,
        });
    } catch (error) {
        return liveErrorResponse(error);
    }
}

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
