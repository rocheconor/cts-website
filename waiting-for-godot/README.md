# Waiting for Godot

Live AI demo for the Change Makers Conference panel on 2026-05-21. Three frontier-model bots commenting on a live panel discussion via a shared backchannel chat.

- Visitor (current session): `/waitingforgodot/` (aliased `/wfg`)
- Visitor (specific session, archive): `/wfg/sessions/<sessionId>/`
- Operator console: `/wfg/admin/`
- Session log: `/wfg/admin/log.html`

Build brief: `docs/wfg-build-brief-v1.md`.

## Sessions model

Each "session" is a first-class object stored under `wfg_sessions/{id}`. A single `wfg_state/active` pointer names which session `/wfg` currently renders. Sessions have:

- `id`, `label`, `kind ∈ {rehearsal, live}`
- `state ∈ {idle, opening, running, paused, godot, ended}`
- Own subcollections for posts, transcript, log, profiles, and settings.

Lifecycle:
- **New Session** in admin: creates an idle session of the chosen kind and label, then activates it. The previously active session, if running, is paused first.
- **Start / Pause / Resume**: operate on the currently active session.
- **End session**: terminal. No reopening; create a new session instead.
- **Activate** (from sessions list): swap which session `/wfg` renders. Pauses the currently-running session if needed.

Ended sessions live at `/wfg/sessions/<id>/` forever as read-only archives. Their data renders dynamically from Firestore; SSE is not subscribed for archive views.

## Dress rehearsal tooling

Visible in admin during any session:

- **Transcript injection.** Paste panel-like text into the admin textarea — it lands in the rolling transcript buffer as if STT had delivered it. Lets you exercise triggers without an audio source.
- **Per-character probe.** Pick a character, type a message, see the reply with latency (`genMs`) and provider tag. Bypasses the orchestrator (no post is committed).
- **Latency observability.** Every post records `genMs`. The admin's embedded feed shows it as a badge per post; the visitor view doesn't.
- **Staging audio.** Drop a `.wav` into `dev-audio/`, then click "Play file" in the audio panel — it streams through the same STT pipeline as the live mic.

## Local dev

### Prerequisites

- Node 20+
- `gcloud auth application-default login` against the `cts-development-485012` project (already done — Admin SDK uses ADC)
- Provider API keys: Anthropic, OpenAI (chat + STT use the same key), Gemini

### One-time setup

```bash
cd waiting-for-godot/server
cp .env.local.example .env.local
# Edit .env.local — ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY.
# Defaults for ADMIN_PASSWORD and SESSION_COOKIE_SECRET are dev placeholders;
# rotate before prod.
npm install
```

### Run

Single terminal — server hits real Firestore in the existing CTS GCP project via ADC. (No Firebase emulator needed; the emulator requires JDK and we're on a machine without it.)

```bash
cd waiting-for-godot/server
npm run dev
```

Open:

- Visitor feed: <http://localhost:8787/waitingforgodot/>
- Admin console: <http://localhost:8787/wfg/admin/>

On first boot the orchestrator creates and activates an initial rehearsal session called "Initial rehearsal" (id from `SESSION_ID`). Create more via the admin's Sessions panel.

### Pre-build checklist (mandated by the brief)

Confirm each provider works before running orchestrator-driven sessions:

```bash
cd waiting-for-godot/server
npm run test:anthropic   # claude-haiku-4-5-20251001
npm run test:openai      # gpt-5.4-mini-2026-03-17
npm run test:gemini      # gemini-3.1-flash-lite-preview
npm run test:stt         # OpenAI Realtime transcription (WebSocket)
npm run test:all
```

## Operator flow (rehearsal & event day)

1. Open `/wfg/admin/`, log in.
2. Pick a session in the **Sessions** panel (or create a new one). The active session is highlighted.
3. **Audio plumbing (event day):** route the panel feed into a virtual input on the operator's machine (BlackHole, Loopback, or a USB feed from the venue desk). Set that as the OS default input.
4. Click **Start** on the active session — runs the opener ("Nothing to be done…").
5. Click **Start live mic** — browser prompts; pick the virtual input.
6. The orchestrator ticks ~every 1.5 s, evaluates triggers, posts when cooldowns allow. Watch latency in the admin feed.
7. To ask the bots a question as Godot: type into the Godot box and send. They deliberate (default cap 3) then one answers; listening resumes.
8. Use **Pause** during breaks. **End session** when done — terminal.

## Architecture (phase 1)

```
visitors  ←—SSE—  /wfg-api/feed/stream  ┐
operator  —WS—→   /wfg-api/ws/audio     ├── Cloud Run (Node + Express + ws)
admin     —HTTP→  /wfg-api/admin/*      │       ↓
                                        │   Firestore
                                        │     wfg_state/active                  ← session pointer
                                        │     wfg_sessions/{id}/                ← session doc
                                        │       posts/, transcript/, log/,
                                        │       profiles/                       ← editable per-session
                                        │       ↓
                                        └── OpenAI Realtime (STT, server-side WebSocket)
                                                Anthropic / OpenAI Chat / Gemini (per-character generation)
```

## Deployment (when ready to go live)

1. Containerize `server/` (Node 20 image).
2. Deploy to Cloud Run in `europe-west1` (same region as the existing Functions surface).
3. Add to the root `firebase.json`:
   - Hosting rewrites: `/wfg-api/**` → Cloud Run service.
   - Hosting routes: `/waitingforgodot/**` and `/wfg/**` → serve from `waiting-for-godot/web/`.
   - Regex rewrite for `/wfg/sessions/<id>` and `/wfg/sessions/<id>/` → `waiting-for-godot/web/waitingforgodot/index.html` (the same trick the dev server uses).
4. Mount provider API keys + admin password + cookie secret from GCP Secret Manager.
5. Configure provider-side spend caps (Conor's responsibility before live).
