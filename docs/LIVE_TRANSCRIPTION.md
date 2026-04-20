# Live Transcription Guide

This guide covers OpenPlaud live transcription using the browser microphone.

## Important Scope

Live transcription in OpenPlaud is **browser-mic capture from the current tab/session**.

It is **not** Plaud Note / NotePin hardware live streaming and does not connect to a Plaud device in real time.

## Architecture Flow

```text
Browser mic permission
  -> MediaRecorder chunks in browser session
  -> OpenPlaud app live transcription pipeline
  -> (Optional) WhisperLive server for streaming ASR
  -> Partial/final transcript shown in UI
```

The WhisperLive backend is optional and controlled by environment flags. OpenPlaud only attempts WhisperLive calls when `WHISPERLIVE_ENABLED=true`.

## Environment Variables

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |
| `LIVE_TRANSCRIPTION_ENABLED` | boolean | `false` | Master feature flag for browser-mic live transcription |
| `WHISPERLIVE_ENABLED` | boolean | `false` | Enables WhisperLive backend integration |
| `WHISPERLIVE_URL` | string | unset | Required at runtime only when both flags above are `true` |
| `WHISPERLIVE_TIMEOUT_MS` | integer | `15000` | Request timeout when calling WhisperLive |
| `LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES` | integer | `30` | Hard cap per session |
| `LIVE_TRANSCRIPTION_DEFAULT_LANGUAGE` | string | `auto` | Default language selection |
| `LIVE_TRANSCRIPTION_DEFAULT_MODEL` | string | `small` | Default model selection |

### Runtime Guard

If `LIVE_TRANSCRIPTION_ENABLED=true` and `WHISPERLIVE_ENABLED=true`, then `WHISPERLIVE_URL` must be set or startup fails with a config validation error.

## Docker Compose Usage

Default startup remains app + database only:

```bash
docker compose up -d
```

Enable WhisperLive with the optional profile:

```bash
docker compose --profile live-transcription up -d
```

Recommended app env when profile is enabled:

```env
LIVE_TRANSCRIPTION_ENABLED=true
WHISPERLIVE_ENABLED=true
WHISPERLIVE_URL=http://whisperlive:9090
```

`whisperlive` is only exposed on the internal Docker network by default (`expose: 9090`), not on a public host port.

For local debugging only, you can temporarily publish the port in `docker-compose.yml`:

```yaml
ports:
  - "9090:9090"
```

Do not keep this host port open on internet-facing deployments.

## Browser Compatibility

| Browser | Status | Notes |
| --- | --- | --- |
| Chrome (desktop) | Recommended | Most stable MediaRecorder behavior |
| Edge (desktop) | Supported | Chromium engine behavior |
| Firefox (desktop) | Supported | Validate codec/latency in your environment |
| Safari (desktop/macOS) | Partial | Test mic permission and recording format |
| Mobile browsers | Limited | Backgrounding, permission, and session reliability vary |

## Security Notes

- Mic access requires explicit browser permission from the user.
- Keep WhisperLive on internal/private network paths whenever possible.
- If reverse-proxying WhisperLive, protect it with network ACLs and auth where applicable.
- Do not treat live transcript transport as trusted input; validate and sanitize at API boundaries.
- In shared environments, enforce HTTPS for the OpenPlaud app before enabling microphone features.

## Limitations

- This does not ingest a live stream directly from Plaud hardware devices.
- Accuracy and latency depend on model size, host CPU/GPU, and network path to WhisperLive.
- Browser/device power-saving can interrupt long sessions.
- Session duration is intentionally capped by `LIVE_TRANSCRIPTION_MAX_SESSION_MINUTES`.

## Troubleshooting

### "Live transcription is unavailable"

1. Verify `LIVE_TRANSCRIPTION_ENABLED=true`.
2. Restart app after env changes.
3. Check browser mic permission for your app origin.

### "WhisperLive connection timeout"

1. Verify `WHISPERLIVE_ENABLED=true` and `WHISPERLIVE_URL` is reachable from app container.
2. If using Docker profile, confirm `whisperlive` container is healthy:
   ```bash
   docker compose --profile live-transcription ps
   ```
3. Increase `WHISPERLIVE_TIMEOUT_MS` for slower deployments.

### "Profile enabled but service not reachable"

1. Confirm the profile command includes `--profile live-transcription`.
2. Verify `WHISPERLIVE_URL=http://whisperlive:9090` when app and WhisperLive are in the same compose project.
3. Avoid exposing port `9090` publicly unless you are actively debugging.
