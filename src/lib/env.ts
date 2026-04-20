import { z } from "zod";

const booleanFromEnv = (defaultValue: boolean) =>
    z
        .string()
        .optional()
        .default(defaultValue ? "true" : "false")
        .transform((value, ctx) => {
            const normalized = value.trim().toLowerCase();
            if (!normalized) {
                return defaultValue;
            }

            if (["1", "true", "yes", "on"].includes(normalized)) {
                return true;
            }

            if (["0", "false", "no", "off"].includes(normalized)) {
                return false;
            }

            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    "must be a boolean string (true/false, 1/0, yes/no, on/off)",
            });
            return z.NEVER;
        });

const integerFromEnv = (
    defaultValue: number,
    variableName: string,
    minimum: number,
) =>
    z
        .string()
        .optional()
        .default(String(defaultValue))
        .transform((value, ctx) => {
            const normalized = value.trim();
            if (!normalized) {
                return defaultValue;
            }

            if (!/^-?\d+$/.test(normalized)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `${variableName} must be an integer`,
                });
                return z.NEVER;
            }

            const parsed = Number.parseInt(normalized, 10);

            if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `${variableName} must be an integer`,
                });
                return z.NEVER;
            }

            if (parsed < minimum) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `${variableName} must be greater than or equal to ${minimum}`,
                });
                return z.NEVER;
            }

            return parsed;
        });

const envSchema = z.object({
    // Server-required values are optional at schema level so that `next build`
    // (phase-production-build) doesn't depend on server-only secrets.
    DATABASE_URL: z.string().optional(),

    BETTER_AUTH_SECRET: z.string().optional(),
    APP_URL: z.string().url("APP_URL must be a valid URL").optional(),

    // Encryption
    // Optional at env-schema level so that builds don't fail if it's missing;
    // encryption code is responsible for enforcing a strong key at runtime.
    ENCRYPTION_KEY: z.string().optional(),

    DEFAULT_STORAGE_TYPE: z.enum(["local", "s3"]).optional().default("local"),
    LOCAL_STORAGE_PATH: z.string().optional().default("./storage"),
    S3_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z
        .string()
        .optional()
        .transform((val) => (val ? parseInt(val, 10) : undefined)),
    SMTP_SECURE: z
        .string()
        .optional()
        .transform((val) => val === "true"),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z
        .string()
        .optional()
        .refine(
            (val) => {
                if (!val) return true;
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                const nameEmailRegex = /^.+ <[^\s@]+@[^\s@]+\.[^\s@]+>$/;
                return emailRegex.test(val) || nameEmailRegex.test(val);
            },
            {
                message:
                    'SMTP_FROM must be an email address (e.g., "user@example.com") or formatted as "Name <user@example.com>"',
            },
        ),

    LIVE_TRANSCRIPTION_ENABLED: booleanFromEnv(false),
    WHISPERLIVE_ENABLED: booleanFromEnv(false),
    WHISPERLIVE_URL: z
        .string()
        .optional()
        .transform((value) => {
            const trimmed = value?.trim();
            return trimmed ? trimmed : undefined;
        }),
    WHISPERLIVE_TIMEOUT_MS: integerFromEnv(15000, "WHISPERLIVE_TIMEOUT_MS", 1),
    LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES: integerFromEnv(
        30,
        "LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES",
        1,
    ),
    LIVE_TRANSCRIPTION_DEFAULT_LANGUAGE: z
        .string()
        .optional()
        .default("auto"),
    LIVE_TRANSCRIPTION_DEFAULT_MODEL: z.string().optional().default("small"),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
    if (typeof window !== "undefined") {
        throw new Error(
            "Environment variables cannot be accessed on the client side. " +
                "This module should only be imported in server-side code (API routes, server components, etc.).",
        );
    }

    try {
        const parsed = envSchema.parse({
            DATABASE_URL: process.env.DATABASE_URL,
            BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
            APP_URL: process.env.APP_URL,
            ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
            DEFAULT_STORAGE_TYPE: process.env.DEFAULT_STORAGE_TYPE,
            LOCAL_STORAGE_PATH: process.env.LOCAL_STORAGE_PATH,
            S3_ENDPOINT: process.env.S3_ENDPOINT,
            S3_BUCKET: process.env.S3_BUCKET,
            S3_REGION: process.env.S3_REGION,
            S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
            S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
            SMTP_HOST: process.env.SMTP_HOST,
            SMTP_PORT: process.env.SMTP_PORT,
            SMTP_SECURE: process.env.SMTP_SECURE,
            SMTP_USER: process.env.SMTP_USER,
            SMTP_PASSWORD: process.env.SMTP_PASSWORD,
            SMTP_FROM: process.env.SMTP_FROM,
            LIVE_TRANSCRIPTION_ENABLED: process.env.LIVE_TRANSCRIPTION_ENABLED,
            WHISPERLIVE_ENABLED: process.env.WHISPERLIVE_ENABLED,
            WHISPERLIVE_URL: process.env.WHISPERLIVE_URL,
            WHISPERLIVE_TIMEOUT_MS: process.env.WHISPERLIVE_TIMEOUT_MS,
            LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES:
                process.env.LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES,
            LIVE_TRANSCRIPTION_DEFAULT_LANGUAGE:
                process.env.LIVE_TRANSCRIPTION_DEFAULT_LANGUAGE,
            LIVE_TRANSCRIPTION_DEFAULT_MODEL:
                process.env.LIVE_TRANSCRIPTION_DEFAULT_MODEL,
        });

        // In runtime (dev/prod servers), we require a strong encryption key.
        // During `next build` (phase-production-build) we skip this so that
        // server-only config doesn't break the frontend build.
        const isProductionBuildPhase =
            process.env.NEXT_PHASE === "phase-production-build";

        if (!isProductionBuildPhase) {
            // Core server-side envs must be present when the server actually runs.
            if (!parsed.DATABASE_URL) {
                throw new Error(
                    "DATABASE_URL must be set in non-build runtime (dev/prod server)",
                );
            }

            if (!parsed.BETTER_AUTH_SECRET) {
                throw new Error(
                    "BETTER_AUTH_SECRET must be set in non-build runtime (dev/prod server)",
                );
            }
            if (parsed.BETTER_AUTH_SECRET.length < 32) {
                throw new Error(
                    "BETTER_AUTH_SECRET must be at least 32 characters",
                );
            }

            if (!parsed.APP_URL) {
                throw new Error(
                    "APP_URL must be set in non-build runtime (dev/prod server)",
                );
            }

            if (
                parsed.LIVE_TRANSCRIPTION_ENABLED &&
                parsed.WHISPERLIVE_ENABLED &&
                !parsed.WHISPERLIVE_URL
            ) {
                throw new Error(
                    "WHISPERLIVE_URL must be set when LIVE_TRANSCRIPTION_ENABLED=true and WHISPERLIVE_ENABLED=true",
                );
            }

            // Encryption key: required and strong at runtime, ignored during build.
            const key = parsed.ENCRYPTION_KEY;
            if (!key) {
                throw new Error(
                    "ENCRYPTION_KEY must be set in non-build runtime (dev/prod server)",
                );
            }
            const isValidHexKey = /^[0-9a-fA-F]{64}$/.test(key);
            if (!isValidHexKey) {
                throw new Error(
                    "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)",
                );
            }
        }

        return parsed;
    } catch (error) {
        if (error instanceof z.ZodError) {
            const issues = error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("\n");
            throw new Error(`Environment validation failed:\n${issues}`);
        }
        throw error;
    }
}

export const env = validateEnv();
