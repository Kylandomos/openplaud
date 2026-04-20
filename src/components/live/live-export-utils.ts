"use client";

export type LiveExportFormat = "txt" | "json" | "srt";

type JsonRecord = Record<string, unknown>;

export interface LiveExportSegment {
    id: string;
    seq: number;
    text: string;
    startMs: number | null;
    endMs: number | null;
    isFinal: boolean;
}

export interface LiveExportSnapshot {
    id: string | null;
    status: string | null;
    language: string | null;
    transcriptText: string;
    segments: LiveExportSegment[];
    createdAt: string | null;
    updatedAt: string | null;
    stoppedAt: string | null;
    finalizedAt: string | null;
}

export interface LiveCurrentExportInput {
    id: string | null;
    status: string | null;
    language: string | null;
    transcriptText: string;
    segments: Array<{
        id: string;
        seq: number;
        text: string;
        startMs?: number;
        endMs?: number;
        isFinal: boolean;
    }>;
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
            if (trimmed) {
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

function clampMs(value: number | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    return Math.max(0, Math.round(value));
}

function normalizeSegment(
    source: JsonRecord,
    fallbackSeq: number,
): LiveExportSegment | null {
    const text = getString(source, "text", "transcript");
    if (!text) return null;

    const seqFromId = (() => {
        const idValue = getString(source, "id");
        if (!idValue) return undefined;
        const parsed = Number.parseInt(idValue, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    })();

    const rawSeq =
        getNumber(source, "segmentSeq", "seq") ?? seqFromId ?? fallbackSeq;
    const seq =
        typeof rawSeq === "number" && Number.isFinite(rawSeq) && rawSeq > 0
            ? Math.floor(rawSeq)
            : fallbackSeq;

    const startMs =
        clampMs(getNumber(source, "startMs")) ??
        clampMs(
            (() => {
                const startSec = getNumber(source, "startSec", "start");
                if (typeof startSec !== "number") return undefined;
                return startSec * 1000;
            })(),
        );
    const endMs =
        clampMs(getNumber(source, "endMs")) ??
        clampMs(
            (() => {
                const endSec = getNumber(source, "endSec", "end");
                if (typeof endSec !== "number") return undefined;
                return endSec * 1000;
            })(),
        );

    return {
        id: getString(source, "id") || `${seq}`,
        seq,
        text,
        startMs,
        endMs,
        isFinal: source.isFinal !== false,
    };
}

function normalizeSegments(source: JsonRecord): LiveExportSegment[] {
    const segmentList = Array.isArray(source.transcriptSegments)
        ? source.transcriptSegments
        : Array.isArray(source.segments)
          ? source.segments
          : [];

    const normalized: LiveExportSegment[] = [];
    for (let index = 0; index < segmentList.length; index += 1) {
        const row = segmentList[index];
        if (!isJsonRecord(row)) continue;
        const segment = normalizeSegment(row, index + 1);
        if (!segment) continue;
        normalized.push(segment);
    }

    return normalized.sort((left, right) => left.seq - right.seq);
}

function resolveSnapshotSource(raw: unknown): JsonRecord | null {
    if (!isJsonRecord(raw)) return null;
    if (isJsonRecord(raw.session)) return raw.session;
    if (isJsonRecord(raw.snapshot)) return raw.snapshot;
    return raw;
}

function formatSrtTimestamp(ms: number): string {
    const total = Math.max(0, Math.floor(ms));
    const hours = Math.floor(total / 3_600_000);
    const minutes = Math.floor((total % 3_600_000) / 60_000);
    const seconds = Math.floor((total % 60_000) / 1000);
    const milliseconds = total % 1000;
    return `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${seconds.toString().padStart(2, "0")},${milliseconds
        .toString()
        .padStart(3, "0")}`;
}

function sanitizeFilename(value: string): string {
    return value.replace(/[^a-z0-9-_.]/gi, "-").replace(/-+/g, "-");
}

function normalizeSnapshot(
    source: JsonRecord,
    fallbackId?: string,
): LiveExportSnapshot {
    const segments = normalizeSegments(source);
    const transcriptText =
        getString(source, "transcriptText", "text") ||
        segments
            .map((segment) => segment.text)
            .join("\n")
            .trim();

    return {
        id: getString(source, "id", "sessionId") || fallbackId || null,
        status: getString(source, "status") || null,
        language: getString(source, "language", "detectedLanguage") || null,
        transcriptText,
        segments,
        createdAt: getString(source, "createdAt", "startedAt") || null,
        updatedAt: getString(source, "updatedAt") || null,
        stoppedAt: getString(source, "stoppedAt") || null,
        finalizedAt: getString(source, "finalizedAt") || null,
    };
}

function getDefaultFilenameBase(snapshot: LiveExportSnapshot): string {
    const id = snapshot.id || "session";
    return sanitizeFilename(`live-transcription-${id}`);
}

function toTxt(snapshot: LiveExportSnapshot): string {
    if (snapshot.transcriptText.trim()) {
        return snapshot.transcriptText.trim();
    }

    return snapshot.segments
        .map((segment) => segment.text.trim())
        .filter((line) => line.length > 0)
        .join("\n");
}

function toJson(snapshot: LiveExportSnapshot): string {
    return JSON.stringify(snapshot, null, 2);
}

function toSrt(snapshot: LiveExportSnapshot): string {
    if (snapshot.segments.length === 0) {
        const fallbackText = snapshot.transcriptText.trim();
        if (!fallbackText) return "";
        return `1\n00:00:00,000 --> 00:00:04,000\n${fallbackText}\n`;
    }

    let fallbackStartMs = 0;
    return snapshot.segments
        .filter((segment) => segment.text.trim().length > 0)
        .map((segment, index) => {
            const startMs =
                typeof segment.startMs === "number"
                    ? segment.startMs
                    : fallbackStartMs;
            const endMs =
                typeof segment.endMs === "number"
                    ? Math.max(segment.endMs, startMs + 500)
                    : startMs + 2000;
            fallbackStartMs = endMs;

            return `${index + 1}\n${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(
                endMs,
            )}\n${segment.text.trim()}\n`;
        })
        .join("\n");
}

function triggerDownload(
    filename: string,
    content: string,
    contentType: string,
): void {
    const blob = new Blob([content], { type: contentType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
}

export function createLiveSnapshotFromCurrent(
    input: LiveCurrentExportInput,
): LiveExportSnapshot {
    const segments = input.segments
        .map((segment) => ({
            id: segment.id,
            seq: segment.seq,
            text: segment.text,
            startMs:
                typeof segment.startMs === "number"
                    ? Math.max(0, Math.round(segment.startMs))
                    : null,
            endMs:
                typeof segment.endMs === "number"
                    ? Math.max(0, Math.round(segment.endMs))
                    : null,
            isFinal: segment.isFinal,
        }))
        .sort((left, right) => left.seq - right.seq);

    return {
        id: input.id,
        status: input.status,
        language: input.language,
        transcriptText: input.transcriptText.trim(),
        segments,
        createdAt: null,
        updatedAt: null,
        stoppedAt: null,
        finalizedAt: null,
    };
}

export function normalizeLiveSnapshotForExport(
    raw: unknown,
    fallbackId?: string,
): LiveExportSnapshot | null {
    const source = resolveSnapshotSource(raw);
    if (!source) return null;
    return normalizeSnapshot(source, fallbackId);
}

export function downloadLiveSnapshot(
    snapshot: LiveExportSnapshot,
    format: LiveExportFormat,
    filenameBase?: string,
): void {
    const base = sanitizeFilename(
        filenameBase || getDefaultFilenameBase(snapshot),
    );

    if (format === "txt") {
        triggerDownload(
            `${base}.txt`,
            toTxt(snapshot),
            "text/plain;charset=utf-8",
        );
        return;
    }

    if (format === "json") {
        triggerDownload(
            `${base}.json`,
            toJson(snapshot),
            "application/json;charset=utf-8",
        );
        return;
    }

    triggerDownload(`${base}.srt`, toSrt(snapshot), "text/plain;charset=utf-8");
}
