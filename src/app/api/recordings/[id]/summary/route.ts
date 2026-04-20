import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiEnhancements, recordings } from "@/db/schema";
import {
    generateSummaryForRecording,
    SummaryGenerationError,
} from "@/lib/ai/generate-summary";
import { auth } from "@/lib/auth";

// POST - Generate summary
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const session = await auth.api.getSession({
            headers: request.headers,
        });

        if (!session?.user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 },
            );
        }

        const { id } = await params;
        const body = await request.json().catch(() => ({}));
        const presetId = (body.preset as string) || undefined;

        // Verify recording belongs to user
        const [recording] = await db
            .select()
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, session.user.id),
                ),
            )
            .limit(1);

        if (!recording) {
            return NextResponse.json(
                { error: "Recording not found" },
                { status: 404 },
            );
        }

        const generated = await generateSummaryForRecording(session.user.id, id, {
            presetId,
        });

        return NextResponse.json({
            summary: generated.summary,
            keyPoints: generated.keyPoints,
            actionItems: generated.actionItems,
            provider: generated.provider,
            model: generated.model,
        });
    } catch (error) {
        if (error instanceof SummaryGenerationError) {
            if (error.code === "NO_TRANSCRIPTION") {
                return NextResponse.json(
                    {
                        error: "No transcription available. Transcribe the recording first.",
                    },
                    { status: 400 },
                );
            }

            if (error.code === "NO_AI_PROVIDER") {
                return NextResponse.json(
                    { error: "No AI provider configured" },
                    { status: 400 },
                );
            }

            if (error.code === "PROMPT_LOAD_FAILED") {
                return NextResponse.json(
                    { error: "Failed to load summary prompt" },
                    { status: 500 },
                );
            }
        }

        console.error("Error generating summary:", error);
        return NextResponse.json(
            { error: "Failed to generate summary" },
            { status: 500 },
        );
    }
}

// GET - Fetch existing summary
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const session = await auth.api.getSession({
            headers: request.headers,
        });

        if (!session?.user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 },
            );
        }

        const { id } = await params;

        const [enhancement] = await db
            .select()
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, id),
                    eq(aiEnhancements.userId, session.user.id),
                ),
            )
            .limit(1);

        if (!enhancement) {
            return NextResponse.json({ summary: null });
        }

        return NextResponse.json({
            summary: enhancement.summary,
            keyPoints: enhancement.keyPoints,
            actionItems: enhancement.actionItems,
            provider: enhancement.provider,
            model: enhancement.model,
            createdAt: enhancement.createdAt,
        });
    } catch (error) {
        console.error("Error fetching summary:", error);
        return NextResponse.json(
            { error: "Failed to fetch summary" },
            { status: 500 },
        );
    }
}

// DELETE - Remove summary
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const session = await auth.api.getSession({
            headers: request.headers,
        });

        if (!session?.user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 },
            );
        }

        const { id } = await params;

        await db
            .delete(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, id),
                    eq(aiEnhancements.userId, session.user.id),
                ),
            );

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error deleting summary:", error);
        return NextResponse.json(
            { error: "Failed to delete summary" },
            { status: 500 },
        );
    }
}
