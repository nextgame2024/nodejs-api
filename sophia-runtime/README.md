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

LiveAvatar uses its separate real-time platform and LITE mode so OpenAI remains
responsible for conversation and tools. For sandbox testing, configure:

```bash
LIVEAVATAR_API_KEY=your-liveavatar-key
LIVEAVATAR_SANDBOX=true
LIVEAVATAR_MAX_SESSION_DURATION_SECONDS=60
```

Sandbox mode always uses LiveAvatar's fixed public avatar and ignores
`LIVEAVATAR_AVATAR_ID`. For production, set `LIVEAVATAR_AVATAR_ID`, disable
sandbox mode, and configure the longer session duration allowed by your plan.

## Boundaries

- Core modules depend on `AIProvider`, not OpenAI directly.
- Core modules resolve `AvatarProvider` implementations per session, not at application startup.
- Live business data must flow through the `ToolRegistry`.
- Existing website/Business Manager users can be referenced by external ID, but this runtime database does not use cross-database foreign keys to the existing `users` table.
