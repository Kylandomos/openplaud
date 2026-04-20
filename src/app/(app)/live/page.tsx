import Link from "next/link";
import { LiveWorkstation } from "@/components/live/live-workstation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAuth } from "@/lib/auth-server";
import { env } from "@/lib/env";

export default async function LivePage() {
    await requireAuth();

    const isLiveEnabled = env.LIVE_TRANSCRIPTION_ENABLED;
    const defaultLanguage = env.LIVE_TRANSCRIPTION_DEFAULT_LANGUAGE || "auto";
    const defaultModel = env.LIVE_TRANSCRIPTION_DEFAULT_MODEL || "small";
    const maxSessionMinutes = env.LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES;
    const liveBackendAvailable =
        env.WHISPERLIVE_ENABLED && Boolean(env.WHISPERLIVE_URL);

    if (!isLiveEnabled) {
        return (
            <div className="bg-background">
                <div className="container mx-auto px-4 py-10 max-w-3xl">
                    <Card>
                        <CardHeader>
                            <CardTitle>
                                Live Transcription Is Unavailable
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                Live transcription is not enabled on this
                                server.
                            </p>
                            <Button asChild variant="outline">
                                <Link href="/dashboard">Back to Dashboard</Link>
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </div>
        );
    }

    return (
        <LiveWorkstation
            defaultLanguage={defaultLanguage}
            defaultModel={defaultModel}
            maxSessionMinutes={maxSessionMinutes}
            liveBackendAvailable={liveBackendAvailable}
        />
    );
}
