import { and, eq } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import {
    aiEnhancements,
    apiCredentials,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import {
    getDefaultSummaryPromptConfig,
    getSummaryPromptById,
    type SummaryPromptConfiguration,
} from "./summary-presets";

type SummaryGenerationErrorCode =
    | "NO_TRANSCRIPTION"
    | "PROMPT_LOAD_FAILED"
    | "NO_AI_PROVIDER";

export class SummaryGenerationError extends Error {
    code: SummaryGenerationErrorCode;

    constructor(code: SummaryGenerationErrorCode, message: string) {
        super(message);
        this.name = "SummaryGenerationError";
        this.code = code;
    }
}

export interface GenerateSummaryForRecordingOptions {
    presetId?: string;
}

export interface GenerateSummaryForRecordingResult {
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    provider: string;
    model: string;
    createdAt?: Date;
}

export async function generateSummaryForRecording(
    userId: string,
    recordingId: string,
    options?: GenerateSummaryForRecordingOptions,
): Promise<GenerateSummaryForRecordingResult> {
    // Get transcription text
    const [transcription] = await db
        .select()
        .from(transcriptions)
        .where(eq(transcriptions.recordingId, recordingId))
        .limit(1);

    if (!transcription) {
        throw new SummaryGenerationError(
            "NO_TRANSCRIPTION",
            "No transcription available. Transcribe the recording first.",
        );
    }

    // Get user's summary prompt configuration
    const [userSettingsRow] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

    let promptConfig: SummaryPromptConfiguration =
        getDefaultSummaryPromptConfig();
    if (userSettingsRow?.summaryPrompt) {
        const config = userSettingsRow.summaryPrompt as SummaryPromptConfiguration;
        promptConfig = {
            selectedPrompt: config.selectedPrompt || "general",
            customPrompts: config.customPrompts || [],
        };
    }

    // Determine which prompt to use (body override > user setting > default)
    const selectedPreset =
        options?.presetId || promptConfig.selectedPrompt || "general";
    let promptTemplate = getSummaryPromptById(selectedPreset, promptConfig);

    if (!promptTemplate) {
        const defaultConfig = getDefaultSummaryPromptConfig();
        promptTemplate = getSummaryPromptById(
            defaultConfig.selectedPrompt,
            defaultConfig,
        );
        if (!promptTemplate) {
            throw new SummaryGenerationError(
                "PROMPT_LOAD_FAILED",
                "Failed to load summary prompt",
            );
        }
    }

    // Get AI credentials (prefer enhancement provider, fallback to transcription)
    const [enhancementCredentials] = await db
        .select()
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.userId, userId),
                eq(apiCredentials.isDefaultEnhancement, true),
            ),
        )
        .limit(1);

    const [transcriptionCredentials] = await db
        .select()
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.userId, userId),
                eq(apiCredentials.isDefaultTranscription, true),
            ),
        )
        .limit(1);

    const credentials = enhancementCredentials || transcriptionCredentials;

    if (!credentials) {
        throw new SummaryGenerationError(
            "NO_AI_PROVIDER",
            "No AI provider configured",
        );
    }

    const apiKey = decrypt(credentials.apiKey);

    const openai = new OpenAI({
        apiKey,
        baseURL: credentials.baseUrl || undefined,
    });

    // Use a chat model, not whisper
    // If the configured model is a transcription-only model,
    // fall back to a reasonable chat model for the provider
    let model = credentials.defaultModel || "gpt-4o-mini";
    if (model.includes("whisper")) {
        // Pick a lightweight chat model appropriate for the provider
        const baseUrl = credentials.baseUrl || "";
        if (baseUrl.includes("groq")) {
            model = "llama-3.1-8b-instant";
        } else if (baseUrl.includes("together")) {
            model = "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo";
        } else if (baseUrl.includes("openrouter")) {
            model = "openai/gpt-4o-mini";
        } else {
            model = "gpt-4o-mini";
        }
    }

    // Truncate transcription if too long
    const maxLength = 8000;
    const truncatedTranscription =
        transcription.text.length > maxLength
            ? `${transcription.text.substring(0, maxLength)}...`
            : transcription.text;

    const prompt = promptTemplate.replace("{transcription}", truncatedTranscription);

    const response = await openai.chat.completions.create({
        model,
        messages: [
            {
                role: "system",
                content:
                    "You are a helpful assistant that summarizes audio transcriptions. Always respond with valid JSON only, no markdown formatting or code fences.",
            },
            {
                role: "user",
                content: prompt,
            },
        ],
        temperature: 0.5,
        max_tokens: 2000,
    });

    const rawContent = response.choices[0]?.message?.content?.trim() || "";

    // Parse the JSON response
    let summary = "";
    let keyPoints: string[] = [];
    let actionItems: string[] = [];

    try {
        // Strip markdown code fences if present
        const cleanContent = rawContent
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();
        const parsed = JSON.parse(cleanContent);
        summary = parsed.summary || "";
        keyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [];
        actionItems = Array.isArray(parsed.actionItems) ? parsed.actionItems : [];
    } catch {
        // Fallback: treat entire response as summary text
        summary = rawContent;
    }

    // Upsert into aiEnhancements
    const [existing] = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recordingId),
                eq(aiEnhancements.userId, userId),
            ),
        )
        .limit(1);

    let createdAt = existing?.createdAt;

    if (existing) {
        await db
            .update(aiEnhancements)
            .set({
                summary,
                keyPoints,
                actionItems,
                provider: credentials.provider,
                model,
            })
            .where(eq(aiEnhancements.id, existing.id));
    } else {
        await db
            .insert(aiEnhancements)
            .values({
                recordingId,
                userId,
                summary,
                keyPoints,
                actionItems,
                provider: credentials.provider,
                model,
            });
    }

    return {
        summary,
        keyPoints,
        actionItems,
        provider: credentials.provider,
        model,
        createdAt: createdAt || undefined,
    };
}
