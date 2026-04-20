"use client";

import {
    Bot,
    CheckCircle2,
    Copy,
    Download,
    History,
    Languages,
    Loader2,
    Mic,
    Play,
    Radio,
    RefreshCw,
    Save,
    Square,
    Trash2,
    TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    createLiveSnapshotFromCurrent,
    downloadLiveSnapshot,
    type LiveExportFormat,
    normalizeLiveSnapshotForExport,
} from "@/components/live/live-export-utils";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useLiveSessionHistory } from "@/hooks/use-live-session-history";
import {
    type LiveTranscriptionState,
    useLiveTranscription,
} from "@/hooks/use-live-transcription";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface LiveWorkstationProps {
    defaultLanguage: string;
    defaultModel: string;
    maxSessionMinutes: number;
    liveBackendAvailable: boolean;
}

const LANGUAGE_OPTIONS = [
    { value: "auto", label: "Auto-detect" },
    { value: "en", label: "English" },
    { value: "es", label: "Spanish" },
    { value: "fr", label: "French" },
    { value: "de", label: "German" },
    { value: "it", label: "Italian" },
    { value: "pt", label: "Portuguese" },
    { value: "zh", label: "Chinese" },
    { value: "ja", label: "Japanese" },
    { value: "ko", label: "Korean" },
    { value: "ru", label: "Russian" },
];

const MODEL_OPTIONS = [
    { value: "tiny", label: "Tiny" },
    { value: "base", label: "Base" },
    { value: "small", label: "Small" },
    { value: "medium", label: "Medium" },
    { value: "large-v3", label: "Large v3" },
];

const LIVE_STATUS_META: Record<
    LiveTranscriptionState,
    { label: string; className: string }
> = {
    idle: {
        label: "Idle",
        className: "bg-muted text-muted-foreground",
    },
    "requesting-microphone-permission": {
        label: "Requesting Microphone Permission",
        className:
            "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    },
    connecting: {
        label: "Connecting",
        className:
            "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    },
    listening: {
        label: "Listening",
        className:
            "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    },
    "receiving-partial-transcript": {
        label: "Receiving Partial Transcript",
        className:
            "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    },
    recoverable: {
        label: "Recoverable",
        className:
            "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
    },
    stopped: {
        label: "Stopped",
        className: "bg-muted text-muted-foreground",
    },
    saving: {
        label: "Saving",
        className:
            "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    },
    saved: {
        label: "Saved",
        className:
            "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    },
    error: {
        label: "Error",
        className:
            "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
    },
};

function formatElapsed(elapsedMs: number): string {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")}`;
}

function formatHistoryDate(raw: string | null): string {
    if (!raw) return "Unknown";
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return "Unknown";
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(parsed);
}

function formatDuration(durationMs: number | null): string {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
        return "n/a";
    }
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getHistoryStatusLabel(status: string): string {
    const normalized = status.trim().toLowerCase();
    if (!normalized) return "unknown";
    if (normalized === "finalized") return "saved";
    return normalized;
}

function shortenPreview(text: string): string {
    if (text.length <= 120) return text;
    return `${text.slice(0, 117)}...`;
}

export function LiveWorkstation({
    defaultLanguage,
    defaultModel,
    maxSessionMinutes,
    liveBackendAvailable,
}: LiveWorkstationProps) {
    const [language, setLanguage] = useState(defaultLanguage || "auto");
    const [model, setModel] = useState(defaultModel || "small");
    const [autoSummary, setAutoSummary] = useState(true);
    const [historyBusyKey, setHistoryBusyKey] = useState<string | null>(null);
    const [currentExportFormat, setCurrentExportFormat] =
        useState<LiveExportFormat | null>(null);

    const transcriptViewportRef = useRef<HTMLDivElement | null>(null);
    const shouldStickToBottomRef = useRef(true);

    const {
        state,
        sessionId,
        segments,
        partialTranscript,
        finalTranscript,
        combinedTranscript,
        detectedLanguage,
        elapsedMs,
        isActive,
        isBusy,
        isRecovering,
        canResumeCapture,
        errorMessage,
        recordingId,
        start,
        resumeCapture,
        loadSession,
        stop,
        save,
        discard,
        reset,
        copyTranscript,
    } = useLiveTranscription();

    const {
        items: historyItems,
        isLoading: historyLoading,
        errorMessage: historyError,
        refresh: refreshHistory,
    } = useLiveSessionHistory();

    const sessionLocked = useMemo(
        () =>
            state !== "idle" &&
            state !== "saved" &&
            state !== "error" &&
            state !== "stopped" &&
            state !== "recoverable",
        [state],
    );

    const hasTranscript = combinedTranscript.trim().length > 0;
    const statusMeta = LIVE_STATUS_META[state];
    const canStartOrResume = liveBackendAvailable && !isBusy;
    const canSaveOrDiscard =
        (state === "stopped" ||
            state === "error" ||
            state === "saving" ||
            state === "recoverable") &&
        Boolean(sessionId);

    const handleTranscriptScroll = useCallback(() => {
        const viewport = transcriptViewportRef.current;
        if (!viewport) return;
        const threshold = 120;
        shouldStickToBottomRef.current =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
            threshold;
    }, []);

    useEffect(() => {
        if (!combinedTranscript) return;
        const viewport = transcriptViewportRef.current;
        if (!viewport) return;
        if (shouldStickToBottomRef.current) {
            viewport.scrollTop = viewport.scrollHeight;
        }
    }, [combinedTranscript]);

    const handleStart = useCallback(async () => {
        if (!liveBackendAvailable) {
            toast.error("Live backend is disabled by server configuration.");
            return;
        }

        const didStart = await start({
            language,
            model,
            autoSummary,
        });
        if (!didStart) {
            toast.error(errorMessage || "Unable to start live transcription.");
            return;
        }

        void refreshHistory();
    }, [
        autoSummary,
        errorMessage,
        language,
        liveBackendAvailable,
        model,
        refreshHistory,
        start,
    ]);

    const handleResumeCapture = useCallback(async () => {
        if (!liveBackendAvailable) {
            toast.error("Live backend is disabled by server configuration.");
            return;
        }

        const didResume = await resumeCapture();
        if (!didResume) {
            toast.error(errorMessage || "Unable to resume capture.");
        }
    }, [errorMessage, liveBackendAvailable, resumeCapture]);

    const handleStop = useCallback(async () => {
        await stop();
        void refreshHistory();
    }, [refreshHistory, stop]);

    const handleSave = useCallback(async () => {
        const result = await save(autoSummary);
        if (!result.success) {
            toast.error(errorMessage || "Failed to save session.");
            return;
        }

        if (result.recordingId) {
            toast.success("Session saved and recording is ready.");
        } else {
            toast.success("Session saved.");
        }

        void refreshHistory();
    }, [autoSummary, errorMessage, refreshHistory, save]);

    const handleDiscard = useCallback(async () => {
        if (
            hasTranscript &&
            !window.confirm("Discard this live session? This cannot be undone.")
        ) {
            return;
        }

        const didDiscard = await discard();
        if (!didDiscard) {
            toast.error(errorMessage || "Unable to discard session.");
            return;
        }

        toast.success("Session discarded.");
        void refreshHistory();
    }, [discard, errorMessage, hasTranscript, refreshHistory]);

    const handleCopy = useCallback(async () => {
        const copied = await copyTranscript();
        if (copied) {
            toast.success("Transcript copied.");
            return;
        }
        toast.error("Unable to copy transcript.");
    }, [copyTranscript]);

    const handleStartNewSession = useCallback(async () => {
        reset();
        await handleStart();
    }, [handleStart, reset]);

    const handleRefreshHistory = useCallback(async () => {
        await refreshHistory();
    }, [refreshHistory]);

    const handleLoadHistorySession = useCallback(
        async (targetSessionId: string) => {
            setHistoryBusyKey(`load:${targetSessionId}`);
            try {
                const loaded = await loadSession(targetSessionId);
                if (!loaded) {
                    toast.error(errorMessage || "Unable to load session.");
                    return;
                }
                toast.success("Session loaded.");
            } finally {
                setHistoryBusyKey((current) =>
                    current === `load:${targetSessionId}` ? null : current,
                );
            }
        },
        [errorMessage, loadSession],
    );

    const handleExportCurrent = useCallback(
        async (format: LiveExportFormat) => {
            if (!hasTranscript) return;

            setCurrentExportFormat(format);
            try {
                const snapshot = createLiveSnapshotFromCurrent({
                    id: sessionId,
                    status: state,
                    language: detectedLanguage,
                    transcriptText: combinedTranscript,
                    segments,
                });
                downloadLiveSnapshot(
                    snapshot,
                    format,
                    sessionId
                        ? `live-transcription-${sessionId}`
                        : "live-transcription-current",
                );
            } finally {
                setCurrentExportFormat(null);
            }
        },
        [
            combinedTranscript,
            detectedLanguage,
            hasTranscript,
            segments,
            sessionId,
            state,
        ],
    );

    const handleExportHistory = useCallback(
        async (targetSessionId: string, format: LiveExportFormat) => {
            const busyKey = `export:${targetSessionId}:${format}`;
            setHistoryBusyKey(busyKey);

            try {
                const response = await fetch(
                    `/api/live-transcriptions/${targetSessionId}`,
                );
                const payload = await response.json().catch(() => null);
                if (!response.ok) {
                    toast.error("Could not load this session for export.");
                    return;
                }

                const snapshot = normalizeLiveSnapshotForExport(
                    payload,
                    targetSessionId,
                );
                if (!snapshot) {
                    toast.error("Session export payload was invalid.");
                    return;
                }

                downloadLiveSnapshot(
                    snapshot,
                    format,
                    `live-transcription-${targetSessionId}`,
                );
            } catch {
                toast.error("Could not export this session.");
            } finally {
                setHistoryBusyKey((current) =>
                    current === busyKey ? null : current,
                );
            }
        },
        [],
    );

    return (
        <div className="bg-background" data-testid="live-workstation">
            <div className="container mx-auto px-4 py-6 max-w-6xl">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                    <div>
                        <h1 className="text-3xl font-bold">
                            Live Transcription
                        </h1>
                        <p className="text-muted-foreground text-sm mt-1">
                            Stream microphone audio and capture transcript in
                            real time.
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        asChild
                        data-testid="live-dashboard-link"
                    >
                        <Link href="/dashboard">Dashboard</Link>
                    </Button>
                </div>

                <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <Card data-testid="live-controls-card">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Mic className="w-5 h-5" />
                                Session Controls
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-5">
                            <div className="grid gap-4 md:grid-cols-3">
                                <div className="space-y-2">
                                    <Label htmlFor="live-language">
                                        Language
                                    </Label>
                                    <Select
                                        value={language}
                                        onValueChange={setLanguage}
                                        disabled={sessionLocked || isBusy}
                                    >
                                        <SelectTrigger
                                            id="live-language"
                                            className="w-full"
                                            data-testid="live-language-select"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {LANGUAGE_OPTIONS.map((option) => (
                                                <SelectItem
                                                    key={option.value}
                                                    value={option.value}
                                                >
                                                    {option.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="live-model">Model</Label>
                                    <Select
                                        value={model}
                                        onValueChange={setModel}
                                        disabled={sessionLocked || isBusy}
                                    >
                                        <SelectTrigger
                                            id="live-model"
                                            className="w-full"
                                            data-testid="live-model-select"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {MODEL_OPTIONS.map((option) => (
                                                <SelectItem
                                                    key={option.value}
                                                    value={option.value}
                                                >
                                                    {option.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="flex items-end justify-between rounded-md border px-3 py-2">
                                    <div className="space-y-0.5">
                                        <Label
                                            htmlFor="live-auto-summary"
                                            className="text-sm"
                                        >
                                            Auto Summary
                                        </Label>
                                        <p className="text-xs text-muted-foreground">
                                            Generate summary when saved.
                                        </p>
                                    </div>
                                    <Switch
                                        id="live-auto-summary"
                                        checked={autoSummary}
                                        onCheckedChange={setAutoSummary}
                                        disabled={isActive || isBusy}
                                        data-testid="live-auto-summary-switch"
                                    />
                                </div>
                            </div>

                            {!liveBackendAvailable && (
                                <div
                                    className="rounded-md border border-amber-300/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
                                    data-testid="live-backend-unavailable"
                                >
                                    WhisperLive backend is disabled by server
                                    configuration. Starting or resuming capture
                                    is unavailable.
                                </div>
                            )}

                            <div className="flex flex-wrap items-center gap-2">
                                {(state === "idle" || state === "saved") && (
                                    <Button
                                        onClick={
                                            state === "saved"
                                                ? handleStartNewSession
                                                : handleStart
                                        }
                                        disabled={!canStartOrResume}
                                        data-testid="live-start-button"
                                    >
                                        {isBusy ? (
                                            <>
                                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                Starting...
                                            </>
                                        ) : (
                                            <>
                                                <Radio className="w-4 h-4 mr-2" />
                                                {state === "saved"
                                                    ? "New Session"
                                                    : "Start Live"}
                                            </>
                                        )}
                                    </Button>
                                )}

                                {state === "recoverable" && sessionId && (
                                    <Button
                                        onClick={handleResumeCapture}
                                        disabled={
                                            !canResumeCapture ||
                                            !canStartOrResume
                                        }
                                        data-testid="live-resume-button"
                                    >
                                        <Play className="w-4 h-4 mr-2" />
                                        Resume Capture
                                    </Button>
                                )}

                                {isActive && (
                                    <Button
                                        onClick={handleStop}
                                        variant="outline"
                                        data-testid="live-stop-button"
                                    >
                                        <Square className="w-4 h-4 mr-2" />
                                        Stop
                                    </Button>
                                )}

                                {canSaveOrDiscard && (
                                    <>
                                        <Button
                                            onClick={handleSave}
                                            disabled={state === "saving"}
                                            data-testid="live-save-button"
                                        >
                                            {state === "saving" ? (
                                                <>
                                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                    Saving...
                                                </>
                                            ) : (
                                                <>
                                                    <Save className="w-4 h-4 mr-2" />
                                                    Save Session
                                                </>
                                            )}
                                        </Button>
                                        <Button
                                            onClick={handleDiscard}
                                            variant="outline"
                                            disabled={state === "saving"}
                                            data-testid="live-discard-button"
                                        >
                                            <Trash2 className="w-4 h-4 mr-2" />
                                            Discard
                                        </Button>
                                    </>
                                )}

                                <Button
                                    onClick={handleCopy}
                                    variant="outline"
                                    disabled={!hasTranscript}
                                    data-testid="live-copy-button"
                                >
                                    <Copy className="w-4 h-4 mr-2" />
                                    Copy Transcript
                                </Button>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                        void handleExportCurrent("txt")
                                    }
                                    disabled={
                                        !hasTranscript ||
                                        currentExportFormat !== null
                                    }
                                    data-testid="live-export-current-txt"
                                >
                                    {currentExportFormat === "txt" ? (
                                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                    ) : (
                                        <Download className="w-3.5 h-3.5 mr-1.5" />
                                    )}
                                    TXT
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                        void handleExportCurrent("json")
                                    }
                                    disabled={
                                        !hasTranscript ||
                                        currentExportFormat !== null
                                    }
                                    data-testid="live-export-current-json"
                                >
                                    {currentExportFormat === "json" ? (
                                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                    ) : (
                                        <Download className="w-3.5 h-3.5 mr-1.5" />
                                    )}
                                    JSON
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                        void handleExportCurrent("srt")
                                    }
                                    disabled={
                                        !hasTranscript ||
                                        currentExportFormat !== null
                                    }
                                    data-testid="live-export-current-srt"
                                >
                                    {currentExportFormat === "srt" ? (
                                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                    ) : (
                                        <Download className="w-3.5 h-3.5 mr-1.5" />
                                    )}
                                    SRT
                                </Button>
                            </div>

                            <p className="text-xs text-muted-foreground">
                                Session limit: {maxSessionMinutes} minutes.
                            </p>
                        </CardContent>
                    </Card>

                    <Card data-testid="live-history-card">
                        <CardHeader className="pb-3">
                            <div className="flex items-center justify-between gap-2">
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <History className="w-4 h-4" />
                                    Recent Sessions
                                </CardTitle>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleRefreshHistory}
                                    disabled={historyLoading}
                                    data-testid="live-history-refresh"
                                >
                                    {historyLoading ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                        <RefreshCw className="w-3.5 h-3.5" />
                                    )}
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {historyError && (
                                <p
                                    className="text-xs text-muted-foreground"
                                    data-testid="live-history-error"
                                >
                                    {historyError}
                                </p>
                            )}

                            {historyLoading && historyItems.length === 0 && (
                                <div
                                    className="flex items-center gap-2 text-xs text-muted-foreground"
                                    data-testid="live-history-loading"
                                >
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    Loading recent sessions...
                                </div>
                            )}

                            {!historyLoading && historyItems.length === 0 && (
                                <p
                                    className="text-xs text-muted-foreground"
                                    data-testid="live-history-empty"
                                >
                                    No recent sessions yet.
                                </p>
                            )}

                            {historyItems.map((item) => {
                                const loadBusy =
                                    historyBusyKey === `load:${item.id}`;
                                const txtBusy =
                                    historyBusyKey === `export:${item.id}:txt`;
                                const jsonBusy =
                                    historyBusyKey === `export:${item.id}:json`;
                                const srtBusy =
                                    historyBusyKey === `export:${item.id}:srt`;
                                const itemBusy =
                                    loadBusy || txtBusy || jsonBusy || srtBusy;

                                return (
                                    <div
                                        key={item.id}
                                        className="rounded-md border p-2.5 space-y-2"
                                        data-testid={`live-history-item-${item.id}`}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="text-xs font-medium truncate">
                                                    {item.id}
                                                </p>
                                                <p className="text-[11px] text-muted-foreground">
                                                    {getHistoryStatusLabel(
                                                        item.status,
                                                    )}{" "}
                                                    •{" "}
                                                    {formatHistoryDate(
                                                        item.updatedAt,
                                                    )}
                                                </p>
                                            </div>
                                            {item.id === sessionId && (
                                                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                                    Loaded
                                                </span>
                                            )}
                                        </div>

                                        <p className="text-[11px] text-muted-foreground">
                                            {formatDuration(item.durationMs)} •{" "}
                                            {item.language || "auto"} •{" "}
                                            {item.model || "default"}
                                        </p>

                                        {item.transcriptPreview && (
                                            <p className="text-xs text-muted-foreground">
                                                {shortenPreview(
                                                    item.transcriptPreview,
                                                )}
                                            </p>
                                        )}

                                        <div className="flex flex-wrap gap-1.5">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    void handleLoadHistorySession(
                                                        item.id,
                                                    )
                                                }
                                                disabled={
                                                    itemBusy ||
                                                    isBusy ||
                                                    isRecovering
                                                }
                                                data-testid={`live-history-load-${item.id}`}
                                            >
                                                {loadBusy ? (
                                                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                                ) : (
                                                    <Play className="w-3.5 h-3.5 mr-1" />
                                                )}
                                                Load
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    void handleExportHistory(
                                                        item.id,
                                                        "txt",
                                                    )
                                                }
                                                disabled={itemBusy}
                                                data-testid={`live-history-export-txt-${item.id}`}
                                            >
                                                {txtBusy ? (
                                                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                                ) : (
                                                    <Download className="w-3.5 h-3.5 mr-1" />
                                                )}
                                                TXT
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    void handleExportHistory(
                                                        item.id,
                                                        "json",
                                                    )
                                                }
                                                disabled={itemBusy}
                                                data-testid={`live-history-export-json-${item.id}`}
                                            >
                                                {jsonBusy ? (
                                                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                                ) : (
                                                    <Download className="w-3.5 h-3.5 mr-1" />
                                                )}
                                                JSON
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    void handleExportHistory(
                                                        item.id,
                                                        "srt",
                                                    )
                                                }
                                                disabled={itemBusy}
                                                data-testid={`live-history-export-srt-${item.id}`}
                                            >
                                                {srtBusy ? (
                                                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                                ) : (
                                                    <Download className="w-3.5 h-3.5 mr-1" />
                                                )}
                                                SRT
                                            </Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </CardContent>
                    </Card>
                </div>

                <Card className="mt-6" data-testid="live-transcript-card">
                    <CardHeader>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <CardTitle className="flex items-center gap-2">
                                <Bot className="w-5 h-5" />
                                Transcript Stream
                            </CardTitle>
                            <div className="flex items-center gap-2">
                                <span
                                    className={cn(
                                        "rounded-full px-2.5 py-1 text-xs font-medium",
                                        statusMeta.className,
                                    )}
                                    data-testid="live-status-badge"
                                >
                                    {statusMeta.label}
                                </span>
                                <span
                                    className="text-sm font-mono text-muted-foreground"
                                    data-testid="live-elapsed"
                                >
                                    {formatElapsed(elapsedMs)}
                                </span>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div
                            ref={transcriptViewportRef}
                            onScroll={handleTranscriptScroll}
                            className="min-h-[320px] max-h-[58vh] overflow-y-auto rounded-md border p-4 space-y-3"
                            data-testid="live-transcript-viewport"
                        >
                            {!hasTranscript && (
                                <p className="text-sm text-muted-foreground">
                                    {state ===
                                    "requesting-microphone-permission"
                                        ? "Waiting for microphone permission..."
                                        : state === "connecting"
                                          ? "Connecting to live transcription backend..."
                                          : state === "saving"
                                            ? "Saving session..."
                                            : "Start or load a session to view transcript output."}
                                </p>
                            )}

                            {segments.map((segment) => (
                                <p
                                    key={segment.id}
                                    className="text-sm leading-relaxed whitespace-pre-wrap"
                                >
                                    {segment.text}
                                </p>
                            ))}

                            {partialTranscript && (
                                <div className="rounded-md border border-dashed px-3 py-2 bg-muted/50">
                                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                                        Partial
                                    </p>
                                    <p className="text-sm leading-relaxed whitespace-pre-wrap italic">
                                        {partialTranscript}
                                    </p>
                                </div>
                            )}
                        </div>

                        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                            <div className="flex items-center gap-1.5">
                                <Languages className="w-3.5 h-3.5" />
                                <span>
                                    Detected language:{" "}
                                    {detectedLanguage || "pending"}
                                </span>
                            </div>
                            <span>
                                Final characters: {finalTranscript.length}
                            </span>
                            <span>
                                Partial characters: {partialTranscript.length}
                            </span>
                        </div>

                        {errorMessage && (
                            <div
                                className="rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-200 dark:text-red-100"
                                data-testid="live-error-banner"
                            >
                                <p className="flex items-start gap-2">
                                    <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
                                    <span>{errorMessage}</span>
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {state === "saved" && (
                    <Card className="mt-6" data-testid="live-saved-card">
                        <CardContent className="py-6 space-y-4">
                            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-300">
                                <CheckCircle2 className="w-5 h-5" />
                                <p className="text-sm font-medium">
                                    Session saved successfully.
                                </p>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                {recordingId && (
                                    <Button
                                        asChild
                                        data-testid="live-open-recording"
                                    >
                                        <Link
                                            href={`/recordings/${recordingId}`}
                                        >
                                            Open Recording
                                        </Link>
                                    </Button>
                                )}
                                <Button variant="outline" asChild>
                                    <Link href="/dashboard">Dashboard</Link>
                                </Button>
                            </div>

                            {!recordingId && (
                                <p className="text-sm text-muted-foreground">
                                    Saved session available. No recording file
                                    was generated for this runtime.
                                </p>
                            )}
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
