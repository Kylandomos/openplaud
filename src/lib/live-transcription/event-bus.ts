import type { LiveEvent } from "@/types/live-transcription";

type LiveEventListener = (event: LiveEvent) => void;

export class LiveEventBus {
    private readonly listenersBySession = new Map<
        string,
        Set<LiveEventListener>
    >();

    subscribe(sessionId: string, listener: LiveEventListener): () => void {
        const listeners =
            this.listenersBySession.get(sessionId) ??
            new Set<LiveEventListener>();

        listeners.add(listener);
        this.listenersBySession.set(sessionId, listeners);

        return () => {
            const sessionListeners = this.listenersBySession.get(sessionId);
            if (!sessionListeners) return;

            sessionListeners.delete(listener);
            if (sessionListeners.size === 0) {
                this.listenersBySession.delete(sessionId);
            }
        };
    }

    publish(event: LiveEvent): void {
        const listeners = this.listenersBySession.get(event.sessionId);
        if (!listeners || listeners.size === 0) return;

        for (const listener of listeners) {
            listener(event);
        }
    }
}

export const liveEventBus = new LiveEventBus();
