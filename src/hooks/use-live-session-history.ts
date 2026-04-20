"use client";

import { useCallback, useEffect, useState } from "react";

const HISTORY_LIMIT = 8;

type JsonRecord = Record<string, unknown>;

export interface LiveSessionHistoryItem {
    id: string;
    status: string;
    updatedAt: string | null;
    createdAt: string | null;
    stoppedAt: string | null;
    finalizedAt: string | null;
    durationMs: number | null;
    recordingId: string | null;
    transcriptPreview: string;
    language: string | null;
    model: string | null;
    canResumeCapture: boolean;
    lastSeq: number | null;
}

interface UseLiveSessionHistoryResult {
    items: LiveSessionHistoryItem[];
    isLoading: boolean;
    errorMessage: string | null;
    refresh: () => Promise<void>;
}

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null;
}

function getString(
    source: JsonRecord | null | undefined,
    ...keys: string[]
): string | undefined {
    if (!source) return undefined;
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
    }
    return undefined;
}

function getNumber(
    source: JsonRecord | null | undefined,
    ...keys: string[]
): number | undefined {
    if (!source) return undefined;
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}

function getBoolean(
    source: JsonRecord | null | undefined,
    ...keys: string[]
): boolean | undefined {
    if (!source) return undefined;
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "boolean") {
            return value;
        }
    }
    return undefined;
}

function getItemDate(item: LiveSessionHistoryItem): number {
    const raw =
        item.updatedAt || item.finalizedAt || item.stoppedAt || item.createdAt;
    if (!raw) return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

function extractPreview(
    source: JsonRecord | null | undefined,
    fallbackSource: JsonRecord | null | undefined,
): string {
    const direct =
        getString(
            source,
            "transcriptText",
            "transcriptPreview",
            "preview",
            "snippet",
        ) ||
        getString(
            fallbackSource,
            "transcriptText",
            "transcriptPreview",
            "preview",
            "snippet",
        );
    if (direct) return direct;

    const segmentList = Array.isArray(source?.transcriptSegments)
        ? source.transcriptSegments
        : Array.isArray(source?.segments)
          ? source.segments
          : [];

    const textParts: string[] = [];
    for (const segment of segmentList) {
        if (!isJsonRecord(segment)) continue;
        const text = getString(segment, "text", "transcript");
        if (!text) continue;
        textParts.push(text);
        if (textParts.length >= 3) break;
    }

    return textParts.join(" ").trim();
}

function normalizeHistoryItems(payload: unknown): LiveSessionHistoryItem[] {
    if (!payload) return [];

    const asObject = isJsonRecord(payload) ? payload : null;

    const list = Array.isArray(payload)
        ? payload
        : Array.isArray(asObject?.sessions)
          ? asObject.sessions
          : Array.isArray(asObject?.items)
            ? asObject.items
            : Array.isArray(asObject?.data)
              ? asObject.data
              : Array.isArray(asObject?.results)
                ? asObject.results
                : [];

    const rows: LiveSessionHistoryItem[] = [];

    for (const entry of list) {
        if (!isJsonRecord(entry)) continue;

        const session = isJsonRecord(entry.session) ? entry.session : entry;
        const id =
            getString(session, "id", "sessionId") ||
            getString(entry, "id", "sessionId");
        if (!id) continue;

        const status =
            getString(session, "status") ||
            getString(entry, "status") ||
            "unknown";
        const transcriptPreview = extractPreview(session, entry);

        const resumeObj = isJsonRecord(session.resume)
            ? session.resume
            : isJsonRecord(entry.resume)
              ? entry.resume
              : null;
        const canResumeCapture =
            getBoolean(
                session,
                "canResumeCapture",
                "resumeCapture",
                "resume",
            ) ??
            getBoolean(entry, "canResumeCapture", "resumeCapture", "resume") ??
            getBoolean(
                resumeObj,
                "canCapture",
                "allowed",
                "canResumeCapture",
            ) ??
            ["initializing", "ready", "streaming"].includes(
                status.toLowerCase(),
            );

        rows.push({
            id,
            status,
            updatedAt:
                getString(session, "updatedAt") ||
                getString(entry, "updatedAt") ||
                null,
            createdAt:
                getString(session, "createdAt", "startedAt") ||
                getString(entry, "createdAt", "startedAt") ||
                null,
            stoppedAt:
                getString(session, "stoppedAt") ||
                getString(entry, "stoppedAt") ||
                null,
            finalizedAt:
                getString(session, "finalizedAt") ||
                getString(entry, "finalizedAt") ||
                null,
            durationMs:
                getNumber(session, "durationMs", "duration") ??
                getNumber(entry, "durationMs", "duration") ??
                null,
            recordingId:
                getString(session, "recordingId") ||
                getString(entry, "recordingId") ||
                null,
            transcriptPreview,
            language:
                getString(session, "language", "detectedLanguage") ||
                getString(entry, "language", "detectedLanguage") ||
                null,
            model:
                getString(session, "model") ||
                getString(entry, "model") ||
                null,
            canResumeCapture,
            lastSeq:
                getNumber(session, "lastSeq") ??
                getNumber(entry, "lastSeq") ??
                null,
        });
    }

    return rows
        .sort((left, right) => getItemDate(right) - getItemDate(left))
        .slice(0, HISTORY_LIMIT);
}

export function useLiveSessionHistory(): UseLiveSessionHistoryResult {
    const [items, setItems] = useState<LiveSessionHistoryItem[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setIsLoading(true);

        try {
            const response = await fetch(
                `/api/live-transcriptions?limit=${HISTORY_LIMIT}`,
            );
            if (!response.ok) {
                if (
                    response.status === 404 ||
                    response.status === 405 ||
                    response.status === 501 ||
                    response.status === 503
                ) {
                    setItems([]);
                    setErrorMessage(null);
                    return;
                }

                setErrorMessage("Recent sessions could not be loaded.");
                return;
            }

            const payload = (await response
                .json()
                .catch(() => null)) as unknown;
            setItems(normalizeHistoryItems(payload));
            setErrorMessage(null);
        } catch {
            setErrorMessage("Recent sessions could not be loaded.");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return {
        items,
        isLoading,
        errorMessage,
        refresh,
    };
}
