# Waiting for Godot: Build Brief

Build brief for Claude Code. Deliverable is a live AI demo for the Change Makers Conference, running through a 90-minute panel.

## Concept

A standard backchannel chat interface hosted at creativethinkingsystems.com/waitingforgodot (also reachable at /wfg). Three AI bots, each tied to a different frontier model, listen to a live panel discussion via the browser's audio input and post short comments in character throughout. Each bot is named after a character from Samuel Beckett's *Waiting for Godot*. A fourth participant, Godot (the operator), can ask the three a question via a hidden admin page; the three deliberate visibly in the chat and one of them answers.

The page should look and feel like a standard chat backchannel (X, Slack, Reddit): vertical, consecutive, unremarkable as a frame. The substance is the bots; the frame is the demo.

This is a shared live feed. All visitors to the page see the same stream of posts, broadcast from the server like a public X or Reddit thread. There is no per-visitor session. Audio input comes from one source only: the operator's machine, via the admin. Visitors joining mid-session see prior posts from the session and the live stream continues from where it is.

## Characters

Three bots, each tied to a specific provider and speed-tier model:

- **Vladimir ("Didi"):** Claude (Haiku 4.5). The intellectual, protective tramp. Focuses on the future, holds onto hope, remembers the past. Returns to earlier panel themes. Reflective, occasionally pompous.
- **Estragon ("Gogo"):** ChatGPT (GPT-5.4 mini). The physical, helpless tramp. Reacts to immediate and concrete things. Forgets the thread quickly. Terse, often plaintive.
- **Pozzo:** Gemini (Gemini 3.1 Flash-Lite). Wealthy, declamatory, controlling. Comments on power, status, money. Performative. Will dominate if allowed.

Each character knows it is an AI, and treats this fact in a Beckettian register (existential, resigned, vain). Tone across all three: lightly humorous and sarcastic, in character. Beckett references should be light: a hat, a boot, a tree, "nothing happens, twice." Roughly one reference per ten posts. Each character's personal concerns from the play (Gogo's boots and hunger, Didi's hope and memory, Pozzo's authority and dependence) can recur as quiet themes.

The play's specifics must not overwhelm the substance of the panel. The bots are commenting on the panel; Beckett is the costume.

## Chat interface

A single page at /waitingforgodot, also routed at /wfg.

- Standard vertical chat layout. Responsive: phone, tablet, projector.
- Posts always display consecutively in arrival order. No threading, no grouping, no parallel columns. Standard chat flow.
- Each post shows: character avatar, character name, post body, small model badge clearly referencing the provider brand and model identity.
- The URL itself visible somewhere on the page (footer or header) so audience members joining on their phones can find their bearings.
- Subtle CTS credit in the footer.
- No on-screen "what is this" framing copy. Conor will introduce verbally.

## Transcription

Audio input comes from the operator's machine only (not from any visitor's browser). The operator selects the input device at the browser level via the standard system audio picker (Mac OS). Audio streams to the backend for transcription. Real-time streaming STT with low latency is required (target: under 3 seconds from speech to text token available downstream). The transcript is backend-only and not shown in the UI.

Speaker diarisation is not required. The bots comment on substance, not speakers.

**Provider:** OpenAI Realtime transcription. See https://developers.openai.com/api/docs/guides/realtime-transcription. The browser captures audio from the operator-selected input device and streams it to the backend, which proxies into the OpenAI Realtime transcription session. Transcript tokens land in a rolling backend buffer that feeds the speaking-turn logic. If a more reliable or lower-latency option emerges at build time, Claude Code may substitute, but surface the change for Conor's approval first.

## Speaking turn logic

The bots must comment throughout a 90-minute panel. The cadence should feel like a smooth backchannel chat: not round-robin, not chaotic, never distracting from the panel. Stretches of bot silence are fine and often preferable to forced commentary.

Required mechanics:

- Each bot's trigger evaluation runs as a **cheap heuristic** over the recent transcript window, not an LLM call. Keyword and topic matching weighted by the bot's character trigger profile, plus a small random component for variation. Only when the heuristic crosses the bot's threshold AND cooldowns allow does an LLM generation fire.
- A central orchestrator enforces a global cooldown (no two posts within N seconds) and a per-character cooldown (so no one bot dominates). The orchestrator claims the turn before generation starts, so two bots cannot both generate into the same window.
- Default cadence target: 1 to 3 posts per minute across all three, with natural silences. Configurable from the admin panel.
- Bots see each other's recent posts and react. Banter, mild disagreement, and riffing are wanted.
- No mechanical round-robin. Variation is the point.

**Context windows (Claude Code's call, defaults below):**

- Transcript window fed to triggers and generation: rolling last ~5 minutes of transcript.
- Chat history fed to generation: recent ~30 posts.
- Full session transcript and chat are persisted server-side regardless of window size, for the permalink record.

Post length per character (configurable from admin):

- Gogo: roughly 120 characters max. Terse, forgetful.
- Didi: roughly 280 characters max. Reflective, can hold a thought.
- Pozzo: up to 350 characters max. Declamatory, sometimes performs at length.

## Godot interaction

Godot is the human operator (Conor). Godot accesses a hidden admin URL and types a question into a standard chat input. The question appears in the chat as a post from "Godot."

When Godot posts a question:

1. Listening to the panel audio pauses for the duration of the Godot exchange. The transcript and chat context built up so far remain in the bots' working memory throughout the exchange and after it resumes — the Godot pause does not flush context.
2. The three bots deliberate visibly in the chat (no special styling: just normal chat posts). They debate in character. Pozzo will try to dominate; Didi will reason; Gogo will defer to whoever spoke last.
3. **Hard cap on deliberation:** at most 3 deliberation posts total across all three characters before an answer is required. The fourth post must be the agreed answer from whichever character is best placed to give it. The cap is configurable in the backend (env var or admin setting) but defaults to 3.
4. Listening to the panel resumes.

## Admin panel

A single page at /wfg/admin, password-gated. **Auth:** single shared admin password stored as an environment variable on the server, exchanged for an HTTP-only session cookie on login. Sufficient for a one-event demo hosted on the creativethinkingsystems.com site.

Should expose:

- Start, stop, pause for the session.
- Editable system prompts for each character.
- Editable character trigger profiles (configurable; the descriptions in Characters above are the seed values).
- Cadence controls: global cooldown, per-character cooldown, target posts-per-minute ceiling.
- Godot input field (the same input that produces a Godot post in the chat).
- Godot deliberation cap (default 3).
- Link to the live permalink for the current session.
- Link to the session log page (see Failure modes).

## Session lifecycle and persistence

- Manual start by Conor at the top of the panel. Manual stop at the end. No auto-start.
- **One single session for the conference.** Not a multi-session product. Transcript and chat are saved server-side and stay online indefinitely as a permanent record of the event.
- The session has a stable shareable permalink at the same /wfg URL after the event, rendering the chat in read-only mode.
- Transcript visibility on permalink: backend toggle, default off.

## Opening sequence

The session opens with a short character-establishing exchange between the three bots before they start commenting on the panel. This gives the audience the format.

The opener begins:

> Gogo: Nothing to be done.

Followed by a brief back-and-forth between the three: light introductions, in character, acknowledging they are AI. Roughly 30 to 60 seconds before panel substance starts feeding in.

## Failure modes

If a provider API errors or rate-limits mid-session:

- The affected character goes silent for that turn.
- No error is surfaced in the chat.
- The event is written to a session log.

**Session log page.** A separate hidden page at /wfg/admin/log, gated by the same admin auth. Append-only log of provider errors, rate limits, STT disconnects, moderation events (if reintroduced later), and orchestrator decisions. Critical errors are visually highlighted at the top. No green/amber/red dashboard — just a readable log.

## Models and API access

Target models, each tied to its canonical API documentation. Claude Code should work from the linked documentation as the source of truth for SDK patterns, request shapes, streaming support, rate limits, and pricing. Do not infer API details from training data.

- **Claude Haiku 4.5** (Anthropic). Model ID: `claude-haiku-4-5` (pinned snapshot `claude-haiku-4-5-20251001`). Docs: https://platform.claude.com/docs/en/about-claude/models/overview
- **GPT-5.4 mini** (OpenAI). Model ID: `gpt-5.4-mini-2026-03-17`. Docs: https://developers.openai.com/api/docs/models/gpt-5.4-mini
- **Gemini 3.1 Flash-Lite** (Google). Model ID: `gemini-3.1-flash-lite-preview`. Docs: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-preview (preview model; verify availability at build time)
- **STT — OpenAI Realtime transcription.** Docs: https://developers.openai.com/api/docs/guides/realtime-transcription

The lite / flash / mini tier across all three providers is deliberate: keeps per-post cost low across a 90-minute session. Cost containment will primarily be handled via provider-side spend caps configured by Conor, but the cheap-heuristic gating in Speaking turn logic also limits LLM call volume.

Conor will provide API keys for all four (three model providers + OpenAI STT) during the build. Before falling back to any substitute model, surface the issue for Conor's decision. Speed matters more than depth for these characters: latency budget per post is short.

### Pre-build checklist

Before writing any code, the build session must:

1. Fetch each of the four doc URLs above and confirm the named model IDs are live and accessible. If any model is unavailable, retired, or renamed, stop and surface to Conor before continuing.
2. Confirm Conor has supplied API keys for all four providers and that provider-side spend caps are configured (Conor's responsibility, but the build session should confirm before going live).
3. Make a single successful test call to each of the three chat models and the STT endpoint, end-to-end, before building the orchestrator on top.

## Branding

- Each post shows a small badge clearly referencing the provider's brand identity and the specific model in use. Stylised character avatar plus a model badge in the corner.
- Subtle CTS credit in the page footer.

