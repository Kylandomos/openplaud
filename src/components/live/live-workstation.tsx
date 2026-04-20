"use client";

import {
    Bot,
    CheckCircle2,
    Copy,
    Languages,
    Loader2,
    Mic,
    Radio,
    Save,
    Square,
    Trash2,
    TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
    type LiveTranscriptionState,
    useLiveTranscription,
} from "@/hooks/use-live-transcription";
import { cn } from "@/lib/utils";

interface LiveWorkstationProps {
    defaultLanguage: string;
    defaultModel: string;
    maxSessionMinutes: number;
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
        className: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    },
    connecting: {
        label: "Connecting",
        className: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    },
    listening: {
        label: "Listening",
        className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    },
    "receiving-partial-transcript": {
        label: "Receiving Partial Transcript",
        className: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    },
    stopped: {
        label: "Stopped",
        className: "bg-muted text-muted-foreground",
    },
    saving: {
        label: "Saving",
        className: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    },
    saved: {
        label: "Saved",
        className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    },
    error: {
        label: "Error",
        className: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
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

export function LiveWorkstation({
    defaultLanguage,
    defaultModel,
    maxSessionMinutes,
}: LiveWorkstationProps) {
    const [language, setLanguage] = useState(defaultLanguage || "auto");
    const [model, setModel] = useState(defaultModel || "small");
    const [autoSummary, setAutoSummary] = useState(true);

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
        errorMessage,
        recordingId,
        start,
        stop,
        save,
        discard,
        reset,
        copyTranscript,
    } = useLiveTranscription();

    const sessionLocked = useMemo(
        () =>
            state !== "idle" &&
            state !== "saved" &&
            state !== "error" &&
            state !== "stopped",
        [state],
    );

    const hasTranscript = combinedTranscript.trim().length > 0;
    const statusMeta = LIVE_STATUS_META[state];

    const handleTranscriptScroll = useCallback(() => {
        const viewport = transcriptViewportRef.current;
        if (!viewport) return;
        const threshold = 120;
        shouldStickToBottomRef.current =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
            threshold;
    }, []);

    useEffect(() => {
        const viewport = transcriptViewportRef.current;
        if (!viewport) return;

        if (shouldStickToBottomRef.current) {
            viewport.scrollTop = viewport.scrollHeight;
        }
    }, [segments, partialTranscript]);

    const handleStart = useCallback(async () => {
        const didStart = await start({
            language,
            model,
            autoSummary,
        });
        if (!didStart && errorMessage) {
            toast.error(errorMessage);
        }
    }, [autoSummary, errorMessage, language, model, start]);

    const handleStop = useCallback(async () => {
        await stop();
    }, [stop]);

    const handleSave = useCallback(async () => {
        const result = await save(autoSummary);
        if (!result.success) {
            toast.error(errorMessage || "Failed to save session.");
            return;
        }

        if (result.recordingId) {
            toast.success("Session saved and recording is ready.");
            return;
        }

        toast.success("Session saved.");
    }, [autoSummary, errorMessage, save]);

    const handleDiscard = useCallback(async () => {
        if (
            hasTranscript &&
            !window.confirm(
                "Discard this live session? This cannot be undone.",
            )
        ) {
            return;
        }

        const didDiscard = await discard();
        if (!didDiscard) {
            toast.error(errorMessage || "Unable to discard session.");
            return;
        }

        toast.success("Session discarded.");
    }, [discard, errorMessage, hasTranscript]);

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

    return (
        <div className="bg-background">
            <div className="container mx-auto px-4 py-6 max-w-5xl">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                    <div>
                        <h1 className="text-3xl font-bold">Live Transcription</h1>
                        <p className="text-muted-foreground text-sm mt-1">
                            Stream microphone audio and capture transcript in real time.
                        </p>
                    </div>
                    <Button variant="outline" asChild>
                        <Link href="/dashboard">Dashboard</Link>
                    </Button>
                </div>

                <div className="grid gap-6">
                    <Card>
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
                                    />
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                {(state === "idle" || state === "saved") && (
                                    <Button
                                        onClick={
                                            state === "saved"
                                                ? handleStartNewSession
                                                : handleStart
                                        }
                                        disabled={isBusy}
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

                                {isActive && (
                                    <Button
                                        onClick={handleStop}
                                        variant="outline"
                                    >
                                        <Square className="w-4 h-4 mr-2" />
                                        Stop
                                    </Button>
                                )}

                                {(state === "stopped" ||
                                    state === "error" ||
                                    state === "saving") &&
                                    sessionId && (
                                        <>
                                            <Button
                                                onClick={handleSave}
                                                disabled={state === "saving"}
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
                                >
                                    <Copy className="w-4 h-4 mr-2" />
                                    Copy Transcript
                                </Button>
                            </div>

                            <p className="text-xs text-muted-foreground">
                                Session limit: {maxSessionMinutes} minutes.
                            </p>
                        </CardContent>
                    </Card>

                    <Card>
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
                                    >
                                        {statusMeta.label}
                                    </span>
                                    <span className="text-sm font-mono text-muted-foreground">
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
                                                : "Start a live session to view transcript output."}
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
                                <div className="rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-200 dark:text-red-100">
                                    <p className="flex items-start gap-2">
                                        <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
                                        <span>{errorMessage}</span>
                                    </p>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {state === "saved" && (
                        <Card>
                            <CardContent className="py-6 space-y-4">
                                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-300">
                                    <CheckCircle2 className="w-5 h-5" />
                                    <p className="text-sm font-medium">
                                        Session saved successfully.
                                    </p>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    {recordingId && (
                                        <Button asChild>
                                            <Link href={`/recordings/${recordingId}`}>
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
        </div>
    );
}
