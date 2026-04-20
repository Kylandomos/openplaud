# Changelog

All notable changes to OpenPlaud will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Added comprehensive error handling system with safe error messages
- Implemented path traversal protection in local storage
- Fixed environment variable client-side exposure
- Added sensitive information sanitization in error responses

### Fixed
- Fixed storage type bug (was hardcoded to "local")
- Fixed device lookup to properly scope by userId
- Fixed race condition in default provider selection with transactions
- Added audio streaming range validation (416 Range Not Satisfiable)
- Improved content-type detection for multiple audio formats

### Added
- Database unique constraint on plaudDevices (userId + serialNumber)
- Performance indexes on recordings, transcriptions, and plaudDevices tables
- Retry logic for Plaud API calls with exponential backoff
- Standardized error code system for client error handling
- Test and type-check scripts in package.json
- Canonical live transcription environment parsing and defaults in server env validation
- Optional WhisperLive Docker Compose profile (`live-transcription`) while keeping default startup to app + db
- Dedicated live transcription documentation for browser-microphone flow, security, compatibility, and troubleshooting

## [0.1.0] - 2025-01-22

### Added
- Initial release of OpenPlaud
- Self-hosted alternative to Plaud's subscription service
- Support for any OpenAI-compatible API (OpenAI, Groq, Together AI, OpenRouter, LM Studio, Ollama)
- Browser-based transcription using Transformers.js (Whisper models)
- Flexible storage: Local filesystem or S3-compatible (AWS S3, R2, MinIO, etc.)
- Auto-sync with configurable intervals
- Email notifications via SMTP
- Bark notifications for iOS
- Browser notifications
- AI title generation from transcriptions
- Export recordings (JSON, TXT, SRT, VTT formats)
- Backup functionality for all user data
- Modern hardware-inspired UI with dark theme
- Docker deployment with docker-compose
- PostgreSQL database with Drizzle ORM
- Better Auth for authentication
- AES-256-GCM encryption for sensitive data
- Onboarding flow for new users
- Settings management (sync, storage, transcription, AI providers, notifications)
- Audio waveform visualization with Wavesurfer.js
- Recording playback with speed control
- Transcription management
- Device management

### Security
- Encrypted storage for API keys and Plaud bearer tokens
- Secure session management
- Environment variable validation
- Path traversal protection

[unreleased]: https://github.com/openplaud/openplaud/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/openplaud/openplaud/releases/tag/v0.1.0
