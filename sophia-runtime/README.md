# Sophia Runtime API

NestJS TypeScript service for Sophia realtime assistant sessions, provider adapters, avatar adapters, and trusted business tools.

This service is intentionally separate from the existing Express API in `backend/src`.

Runtime target: Node 22.

## Local Setup

```bash
cd backend/sophia-runtime
fnm use 22.23.2
npm install
cp .env.example .env
npm run migrate
npm run build
npm test
npm run start:dev
```

For Phase 1, `SOPHIA_RUNTIME_DATABASE_URL` can point to the existing Neon database while using `SOPHIA_RUNTIME_SCHEMA=sophia_runtime`. For production, prefer a dedicated Sophia Runtime Neon database or project.

## Render

Create a separate Render service scoped to `backend/sophia-runtime`.

Build command:

```bash
npm ci && npm run build
```

Start command:

```bash
npm run start
```

Run migrations before deployment:

```bash
npm run migrate
```

Do not copy secrets into Angular. Browser clients should call this runtime API for short-lived session metadata only.

LiveAvatar uses its separate real-time platform. The session request can select
`avatarMode: "LITE"` or `avatarMode: "FULL"`; `LIVEAVATAR_MODE` is only the
server-side fallback when a mode is not supplied. LITE sends OpenAI's native
24 kHz PCM output to LiveAvatar. FULL requests text-only OpenAI output and lets
LiveAvatar synthesize the voice and lip-sync, avoiding duplicate output-audio
charges. For sandbox testing, configure:

```bash
LIVEAVATAR_API_KEY=your-liveavatar-key
LIVEAVATAR_MODE=FULL
LIVEAVATAR_VOICE_ID=your-liveavatar-voice-id
LIVEAVATAR_SANDBOX=true
LIVEAVATAR_MAX_SESSION_DURATION_SECONDS=60
```

Sandbox mode always uses LiveAvatar's fixed public avatar and ignores
`LIVEAVATAR_AVATAR_ID`. For production, set `LIVEAVATAR_AVATAR_ID`, disable
sandbox mode, and configure the longer session duration allowed by your plan.

## Tavus Full

The `Tavus` kiosk experience uses Tavus's complete conversational pipeline and
does not create an OpenAI Realtime session. Configure a Tavus Persona that uses
the native `tavus-gpt-oss` LLM, then add these variables to the Sophia Runtime
service:

```bash
TAVUS_API_KEY=your-tavus-api-key
TAVUS_PERSONA_ID=your-native-tavus-persona-id
TAVUS_REPLICA_ID=your-replica-id
TAVUS_NATIVE_LLM_ONLY=true
TAVUS_INTERNET_SEARCH_ENABLED=true
```

`TAVUS_REPLICA_ID` is optional when the Persona already has a default replica.
Do not set `TAVUS_NATIVE_LLM_ONLY=true` for a Persona whose LLM layer contains
an OpenAI `base_url` or API key. The runtime refuses Tavus sessions unless this
operator confirmation is enabled, and its Tavus code path never requests an
OpenAI client secret.

The runtime injects the same approved Sophia product profile into OpenAI and
Tavus conversations. OpenAI-based experiences use the `researchBusiness` tool,
which calls OpenAI Responses web search only when business research is
requested. Tavus Full attaches Tavus's native `internet_search` skill to the
PAL and does not use OpenAI for research. Set
`TAVUS_INTERNET_SEARCH_ENABLED=false` only when that behavior is intentionally
disabled.

See [Tavus acceptance suite](./TAVUS_ACCEPTANCE_SUITE.md) before selecting Tavus
as the production default.

## Boundaries

- Core modules depend on `AIProvider`, not OpenAI directly.
- Core modules resolve `AvatarProvider` implementations per session, not at application startup.
- Live business data must flow through the `ToolRegistry`.
- Existing website/Business Manager users can be referenced by external ID, but this runtime database does not use cross-database foreign keys to the existing `users` table.
