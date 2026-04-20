import { NextResponse } from "next/server";
import { liveRuntimeRegistry } from "@/lib/live-transcription/runtime-registry";
import { liveErrorResponse, requireLiveUser } from "../../_common";

export const runtime = "nodejs";

function parseLastEventId(raw: string | null): number {
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed;
}

function formatSseFrame(
    event: string,
    payload: unknown,
    id?: string | number,
): string {
    const lines: string[] = [];
    if (id !== undefined) {
        lines.push(`id: ${id}`);
    }
    lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(payload)}`);
    lines.push("");
    return lines.join("\n");
}

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
        const afterSeq = parseLastEventId(request.headers.get("last-event-id"));
        const { snapshot, events, isActive } =
            await liveRuntimeRegistry.getSessionEventsForRead(
                id,
                context.userId,
                afterSeq,
            );

        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const push = (frame: string) => {
                    controller.enqueue(encoder.encode(frame));
                };

                push(
                    formatSseFrame("snapshot", {
                        session: snapshot,
                        replayedEvents: events.length,
                    }),
                );

                for (const event of events) {
                    push(formatSseFrame("event", event, event.seq));
                }

                if (!isActive) {
                    controller.close();
                    return;
                }

                const heartbeat = setInterval(() => {
                    push(
                        formatSseFrame("heartbeat", {
                            at: new Date().toISOString(),
                        }),
                    );
                }, 15000);

                const unsubscribe = liveRuntimeRegistry.subscribe(
                    id,
                    context.userId,
                    (event) => {
                        push(formatSseFrame("event", event, event.seq));
                    },
                );

                const close = () => {
                    clearInterval(heartbeat);
                    unsubscribe();
                    try {
                        controller.close();
                    } catch {
                        // Stream may already be closed by client disconnect.
                    }
                };

                request.signal.addEventListener("abort", close);
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
            },
        });
    } catch (error) {
        return liveErrorResponse(error);
    }
}
