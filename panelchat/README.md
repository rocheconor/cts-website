# Panelchat

Live AI commentary backchannel for panel discussions. Three frontier-model bots listen to the panel (via real-time STT) and post short, in-character reactions to a public web feed. Audience members can submit questions; operators can inject prompts; an idle-quiet gate keeps the bots silent when nothing is happening.

- **Visitor feed:** `/panelchat/`
- **Operator console:** `/panelchat/admin/`
- **API:** `/panelchat-api/**`
- **Cloud Run service (prod):** `panelchat-server`
- **Firestore namespace:** `panelchat_state`, `panelchat_sessions/{id}/...`

Panelchat is a standalone product. It does not share code, data, or infrastructure with any other project on this host.

## What's in this folder

```
panelchat/
  server/                 ← Node 20 Express + ws orchestrator
    src/
      index.js            ← entrypoint
      config.js
      audio/              ← STT pipe + mic ingest
      lib/                ← auth, Firestore handles, logging
      models/             ← anthropic/openai/gemini clients + prompt builder
      orchestrator/       ← session lifecycle, trigger evaluation, generation
      podcast/            ← NotebookLM Enterprise Podcast API client
      routes/             ← admin / feed / audience routers
      stt/                ← OpenAI Realtime transcription + rolling buffer
  web/
    visitor/              ← public feed (index.html, app.js, styles.css, assets/)
    admin/                ← operator console (index.html, admin.js, admin.css, log.html, pcm-worklet.js)
  deploy/                 ← deploy.sh + secrets template + Firebase hosting patch
  dev-audio/              ← drop .wav files here to fake a panel locally
  Dockerfile              ← Cloud Run image, build context is panelchat/
  .gcloudignore
```

## Local dev

```bash
cd panelchat/server
cp .env.local.example .env.local
# Fill in ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY.
# ADMIN_PASSWORD and SESSION_COOKIE_SECRET have dev placeholders; rotate before prod.
npm install
npm run dev
```

Open:

- Visitor: <http://localhost:8788/panelchat/>
- Admin:   <http://localhost:8788/panelchat/admin/>

Default admin password (dev): `devpassword`.

The server reaches Firestore in `cts-development-485012` via Application Default Credentials. Run `gcloud auth application-default login` once if you haven't.

## Three bots, one session

Each session seeds three character slots, keyed by provider:

| Slot id     | Default display | Default model                       | Voice                                           |
|-------------|-----------------|-------------------------------------|-------------------------------------------------|
| `anthropic` | Claude          | claude-haiku-4-5-20251001           | Reflective, looks for the principle behind a claim |
| `openai`    | GPT             | gpt-5.4-mini-2026-03-17             | Terse, concrete points, sentence fragments      |
| `gemini`    | Gemini          | gemini-3.1-flash-lite-preview       | Punchy, spots incentive structures              |

Provider, model, display name, avatar, system prompt, trigger keywords, and trigger weights are **all editable per-session** from the admin console (Characters panel). The seeds above are only used when a brand-new session is created.

## How a session runs

1. Operator opens `/panelchat/admin/`, picks or creates a session.
2. Click **Start** — the bots run a short three-beat opener so the audience sees they're alive.
3. Click **Start live mic** — routes panel audio via the browser's selected input.
4. As the panel talks, the orchestrator evaluates per-character triggers every 1.5 s and posts when cooldowns allow.
5. To ask a question as the operator, use **Operator question** in the admin (jumps the queue).
6. Enable **Audience Asks** and visitors can submit questions from the live page.
7. **Idle quiet (seconds)** in the Cadence panel: if no transcript segment has arrived in this window, the bots go silent. `0` disables the gate. Questions still go through regardless.
8. **End session** when done (terminal). **Restart** wipes posts + transcript but keeps the session and its profiles. **Delete** wipes the session entirely.

## Downloads

Each session row in the admin has:

- **Transcript** — plain text, one line per completed STT segment. Available at any time.
- **Podcast** — opens a modal. Fill in title, description, focus (narrative direction), pick Short (4–5 min) or Standard (~10 min), optionally include bot chat posts as additional context. Submit → Google NotebookLM Enterprise Podcast API generates an MP3 (a few minutes). Refresh until the row says **ready**, then **Download MP3**.

Podcast generation requires GCP-side enablement. See [`DEPLOY.md`](DEPLOY.md#podcast-prerequisites).

## Architecture

```
visitors  ←—SSE—  /panelchat-api/feed/stream  ┐
operator  —WS—→   /panelchat-api/ws/audio     ├── Cloud Run (Node + Express + ws)
admin     —HTTP→  /panelchat-api/admin/*      │       ↓
                                              │   Firestore
                                              │     panelchat_state/active          ← session pointer
                                              │     panelchat_sessions/{id}/        ← session doc
                                              │       posts/, transcript/, log/,
                                              │       profiles/, podcasts/
                                              │       ↓
                                              └── OpenAI Realtime (STT)
                                                  Anthropic / OpenAI Chat / Gemini (per-character generation)
                                                  Discovery Engine (NotebookLM Enterprise Podcast API)
```

Each session lives under `panelchat_sessions/{id}` in Firestore. A single `panelchat_state/active` doc names which session `/panelchat/` currently renders. Session lifecycle: `idle → opening → running → paused | question → ended`. Boot coerces unsafe in-flight states (`opening`, `question`) to `paused`. A `running` session on cold-start auto-resumes ticking.

See [`DEPLOY.md`](DEPLOY.md) for production deployment.
