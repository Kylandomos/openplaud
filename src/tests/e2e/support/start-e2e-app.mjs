import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
);

const appPort = process.env.E2E_APP_PORT ?? "3100";
const whisperPort = process.env.E2E_WHISPERLIVE_PORT ?? "10090";
const databaseUrl =
    process.env.DATABASE_URL ??
    process.env.E2E_DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:5432/openplaud";

const sharedEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    POSTGRES_URL: process.env.POSTGRES_URL ?? databaseUrl,
    APP_URL: process.env.APP_URL ?? `http://127.0.0.1:${appPort}`,
    BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ??
        "openplaud-e2e-auth-secret-at-least-32-chars",
    ENCRYPTION_KEY:
        process.env.ENCRYPTION_KEY ??
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    LIVE_TRANSCRIPTION_ENABLED: "true",
    WHISPERLIVE_ENABLED: "true",
    WHISPERLIVE_URL:
        process.env.WHISPERLIVE_URL ?? `ws://127.0.0.1:${whisperPort}`,
};

const runCommand = (label, command, args, env = sharedEnv) =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: workspaceRoot,
            env,
            stdio: "inherit",
        });

        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(
                new Error(
                    `${label} failed with exit code ${code ?? "unknown"}`,
                ),
            );
        });
    });

const ensureFileExists = async (targetPath) => {
    try {
        await access(targetPath);
    } catch {
        throw new Error(`Missing required file: ${targetPath}`);
    }
};

const main = async () => {
    const drizzleKitBin = path.join(
        workspaceRoot,
        "node_modules",
        "drizzle-kit",
        "bin.cjs",
    );
    const nextBin = path.join(
        workspaceRoot,
        "node_modules",
        "next",
        "dist",
        "bin",
        "next",
    );

    await ensureFileExists(drizzleKitBin);
    await ensureFileExists(nextBin);

    await runCommand("DB migration", process.execPath, [
        drizzleKitBin,
        "migrate",
        "--config",
        "drizzle.config.ts",
    ]);

    const nextProcess = spawn(
        process.execPath,
        [nextBin, "dev", "--hostname", "127.0.0.1", "--port", appPort],
        {
            cwd: workspaceRoot,
            env: sharedEnv,
            stdio: "inherit",
        },
    );

    const terminate = (signal) => {
        if (nextProcess.killed) {
            return;
        }

        nextProcess.kill(signal);
    };

    process.on("SIGINT", () => terminate("SIGINT"));
    process.on("SIGTERM", () => terminate("SIGTERM"));

    nextProcess.on("exit", (code) => {
        process.exit(code ?? 1);
    });
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
