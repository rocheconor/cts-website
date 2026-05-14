// Central orchestrator. Owns the *currently loaded* session: its state,
// character profiles, cooldowns, trigger evaluation, post generation, and
// the Godot deliberation cap.
//
// Multi-session model:
//   - wfg_state/active doc holds the active sessionId — the one /wfg renders.
//   - Each wfg_sessions/{id} doc holds its own state, settings, profiles,
//     posts, transcript, log.
//   - One orchestrator process holds at most one session loaded at a time.
//     Activating a different session pauses the prior one (if running) and
//     swaps in the new one. Ended sessions are terminal.

import crypto from 'node:crypto';
import { config } from '../config.js';
import { paths, FieldValue } from '../lib/firestore.js';
import { setCurrentSessionId } from '../lib/current-session.js';
import { logError, logInfo, logWarn } from '../lib/log.js';
import { DEFAULT_PROFILES, CHARACTERS, profileSeedArray } from './profiles.js';
import { pickWinner } from './triggers.js';
import { TranscriptBuffer } from '../stt/transcript-buffer.js';
import { generatePostFor } from '../models/index.js';
import { buildUserMessage } from '../models/prompt.js';
import { feed } from './feed.js';

const newId = () => crypto.randomBytes(8).toString('hex');

export const STATES = {
    IDLE: 'idle',
    OPENING: 'opening',
    RUNNING: 'running',
    PAUSED: 'paused',
    GODOT: 'godot',
    ENDED: 'ended',
};

const LIVE_STATES = new Set([STATES.OPENING, STATES.RUNNING, STATES.PAUSED, STATES.GODOT]);

const DEFAULT_SETTINGS = () => ({
    globalCooldownMs: config.defaults.globalCooldownMs,
    perCharacterCooldownMs: config.defaults.perCharacterCooldownMs,
    targetPostsPerMinute: config.defaults.targetPostsPerMinute,
    godotDeliberationCap: config.defaults.godotDeliberationCap,
    audienceGodotEnabled: false,
    // Godot Asks tunables (per session, live editable)
    audienceRateLimitMs: 60_000, // per-IP cooldown between submissions
    audienceMaxChars: 200, // max chars per question
    audienceQueueCap: 50, // max items in queue
});

export class Orchestrator {
    constructor() {
        this.currentSessionId = null;
        this.state = STATES.IDLE;
        this.profiles = new Map();
        this.transcript = new TranscriptBuffer({ persist: false });
        this.settings = DEFAULT_SETTINGS();
        this.session = null; // metadata: {id, label, kind, createdAtMs, ...}

        this.lastPostAt = 0;
        this.lastPostByChar = Object.fromEntries(CHARACTERS.map((c) => [c, 0]));
        this.recentPosts = [];
        this.recentTimestamps = [];

        this.generating = false;
        this.tickHandle = null;
        this.godot = {
            active: false,
            question: null,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: null, // 'deliberating' | 'answering' | null
            source: null,
        };

        // Audience Godot
        this.audienceQueue = []; // [{ id, question, source: 'visitor'|'operator', ip, queuedAtMs }]
        this.audienceRate = new Map(); // ip -> lastSubmittedMs

        // Live typing indicator state
        this.currentTyping = null; // { characterId, displayName, ... } | null
    }

    // ---------- Boot ----------

    async bootstrap() {
        const activeId = await this.#readActivePointer();
        if (activeId) {
            const exists = (await paths.session(activeId).get()).exists;
            if (exists) {
                await this.loadSession(activeId);
                return;
            }
            logWarn('orch', 'active_pointer_dangling', { activeId });
        }
        // Seed first run.
        const seedId = config.sessionId;
        await this.#createSessionDoc({
            id: seedId,
            label: 'Initial rehearsal',
            kind: 'rehearsal',
        });
        await this.#writeActivePointer(seedId);
        await this.loadSession(seedId);
        logInfo('orch', 'bootstrap_seeded_initial', { sessionId: seedId });
    }

    // ---------- Read-only helpers ----------

    initialState({ archive = false } = {}) {
        return {
            sessionId: this.currentSessionId,
            session: this.session,
            state: this.state,
            profiles: this.profileList(),
            posts: this.recentPosts,
            settings: this.settings,
            isArchive: archive || this.state === STATES.ENDED,
            audienceQueueLength: this.audienceQueue.length,
            typing: this.currentTyping,
        };
    }

    audienceQueueSnapshot() {
        return this.audienceQueue.map((q) => ({
            id: q.id,
            question: q.question,
            source: q.source,
            ipMask: q.ip ? q.ip.replace(/\d+$/, '***') : null,
            queuedAtMs: q.queuedAtMs,
        }));
    }

    profileList() {
        return Array.from(this.profiles.values());
    }

    async listSessions() {
        const snap = await paths.sessions().orderBy('createdAtMs', 'desc').get();
        const activeId = await this.#readActivePointer();
        return snap.docs.map((d) => {
            const data = d.data();
            return {
                id: d.id,
                label: data.label || d.id,
                kind: data.kind || 'rehearsal',
                state: data.state || STATES.IDLE,
                createdAtMs: data.createdAtMs || null,
                startedAtMs: data.startedAtMs || null,
                endedAtMs: data.endedAtMs || null,
                isActive: d.id === activeId,
            };
        });
    }

    async readSessionForArchive(sessionId) {
        // Returns a frozen initial-state payload for a non-active session.
        const docSnap = await paths.session(sessionId).get();
        if (!docSnap.exists) throw new Error('session_not_found');
        const meta = docSnap.data();

        const profilesSnap = await paths.profiles(sessionId).get();
        const profiles = profilesSnap.docs.map((d) => d.data());

        const postsSnap = await paths
            .posts(sessionId)
            .orderBy('createdAtMs', 'asc')
            .limit(2000)
            .get();
        const posts = postsSnap.docs.map((d) => serializeForFeed(d.data()));

        return {
            sessionId,
            session: { id: sessionId, ...meta },
            state: meta.state || STATES.ENDED,
            profiles,
            posts,
            settings: meta.settings || DEFAULT_SETTINGS(),
            isArchive: true,
        };
    }

    // ---------- Session lifecycle ----------

    async newSession({ label, kind = 'rehearsal' }) {
        const id = `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        await this.#createSessionDoc({ id, label, kind });
        await this.activateSession(id);
        return id;
    }

    async activateSession(sessionId) {
        if (this.currentSessionId === sessionId) return;
        // Pause currently loaded session if it was live.
        if (this.currentSessionId && LIVE_STATES.has(this.state) && this.state !== STATES.ENDED) {
            await this.#transitionTo(STATES.PAUSED);
            this.#stopTick();
        }
        this.#stopTick();
        await this.#writeActivePointer(sessionId);
        await this.loadSession(sessionId);
        feed.publish({ type: 'session_changed', sessionId });
    }

    async loadSession(sessionId) {
        this.currentSessionId = sessionId;
        setCurrentSessionId(sessionId);

        const docSnap = await paths.session(sessionId).get();
        if (!docSnap.exists) throw new Error(`session_not_found: ${sessionId}`);
        const meta = docSnap.data();
        this.session = { id: sessionId, ...meta };
        // States that imply in-flight work can't be safely resumed after a
        // process restart — coerce them to paused. Operator can Resume or End.
        const persistedState = meta.state || STATES.IDLE;
        if (persistedState === STATES.OPENING || persistedState === STATES.GODOT) {
            this.state = STATES.PAUSED;
            await paths.session(sessionId).set({ state: STATES.PAUSED }, { merge: true });
            logInfo('orch', 'state_coerced_on_load', { from: persistedState, to: STATES.PAUSED });
        } else {
            this.state = persistedState;
        }
        this.settings = { ...DEFAULT_SETTINGS(), ...(meta.settings || {}) };

        // Load (or seed) profiles for this session.
        const profilesSnap = await paths.profiles(sessionId).get();
        this.profiles.clear();
        if (profilesSnap.empty) {
            const batch = paths.profiles(sessionId).firestore.batch();
            for (const p of profileSeedArray()) {
                this.profiles.set(p.id, { ...p });
                batch.set(paths.profile(sessionId, p.id), p);
            }
            await batch.commit();
        } else {
            for (const d of profilesSnap.docs) {
                const data = d.data();
                if (data?.id && DEFAULT_PROFILES[data.id]) {
                    this.profiles.set(data.id, { ...DEFAULT_PROFILES[data.id], ...data });
                }
            }
        }

        // Load recent posts for context + initial feed.
        const postsSnap = await paths
            .posts(sessionId)
            .orderBy('createdAtMs', 'desc')
            .limit(config.defaults.recentChatPostsForContext)
            .get();
        this.recentPosts = postsSnap.docs.map((d) => d.data()).reverse().map(serializeForFeed);

        // Reset per-load runtime fields.
        this.transcript = new TranscriptBuffer({ persist: true, sessionId });
        this.lastPostAt = 0;
        this.lastPostByChar = Object.fromEntries(CHARACTERS.map((c) => [c, 0]));
        this.recentTimestamps = [];
        this.generating = false;
        this.godot = {
            active: false,
            question: null,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: null,
            source: null,
        };

        feed.publish({ type: 'session_loaded', sessionId, state: this.state, session: this.session });
        feed.publishProfiles(this.profileList());

        logInfo('orch', 'loaded_session', { sessionId, label: meta.label, state: this.state });
    }

    async endCurrentSession() {
        if (!this.currentSessionId) return;
        await this.#transitionTo(STATES.ENDED);
        this.#stopTick();
        await paths
            .session(this.currentSessionId)
            .set({ endedAtMs: Date.now(), endedAt: FieldValue.serverTimestamp() }, { merge: true });
        logInfo('orch', 'ended', { sessionId: this.currentSessionId });
    }

    async restartCurrentSession() {
        if (!this.currentSessionId) throw new Error('no_session_loaded');
        if (this.state === STATES.ENDED) throw new Error('session_ended');
        const sid = this.currentSessionId;
        this.#stopTick();
        // Wipe posts + transcript. (Log + profiles preserved.)
        await wipeCollection(paths.posts(sid));
        await wipeCollection(paths.transcript(sid));
        // Reset session metadata: startedAtMs back to null so the next Start
        // records a fresh start time. State to idle.
        await paths.session(sid).set(
            { state: STATES.IDLE, startedAtMs: null, restartedAtMs: Date.now() },
            { merge: true },
        );
        // Reset in-memory runtime state.
        this.transcript = new TranscriptBuffer({ persist: true, sessionId: sid });
        this.recentPosts = [];
        this.lastPostAt = 0;
        this.lastPostByChar = Object.fromEntries(CHARACTERS.map((c) => [c, 0]));
        this.recentTimestamps = [];
        this.generating = false;
        this.godot = {
            active: false,
            question: null,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: null,
            source: null,
        };
        this.state = STATES.IDLE;
        feed.publish({ type: 'session_restarted', sessionId: sid });
        feed.publishState(STATES.IDLE);
        logInfo('orch', 'restarted', { sessionId: sid });
    }

    async endSession(sessionId) {
        if (sessionId === this.currentSessionId) return this.endCurrentSession();
        // End a non-loaded session by writing directly. (Rare; normally
        // sessions are ended via the lifecycle button on the active session.)
        await paths.session(sessionId).set(
            { state: STATES.ENDED, endedAtMs: Date.now(), endedAt: FieldValue.serverTimestamp() },
            { merge: true },
        );
        logInfo('orch', 'ended_remote', { sessionId });
    }

    async #createSessionDoc({ id, label, kind }) {
        const now = Date.now();
        const initial = {
            id,
            label: label || id,
            kind,
            state: STATES.IDLE,
            settings: DEFAULT_SETTINGS(),
            createdAtMs: now,
            createdAt: FieldValue.serverTimestamp(),
            startedAtMs: null,
            endedAtMs: null,
        };
        await paths.session(id).set(initial);
        logInfo('orch', 'session_created', { id, label, kind });
    }

    async #readActivePointer() {
        const snap = await paths.activePointer().get();
        return snap.exists ? snap.data()?.sessionId || null : null;
    }

    async #writeActivePointer(sessionId) {
        await paths.activePointer().set({ sessionId, since: FieldValue.serverTimestamp() });
    }

    // ---------- State transitions ----------

    async #transitionTo(next) {
        this.state = next;
        feed.publishState(next);
        const patch = { state: next };
        if (next === STATES.RUNNING && !this.session?.startedAtMs) {
            patch.startedAtMs = Date.now();
            patch.startedAt = FieldValue.serverTimestamp();
            if (this.session) this.session.startedAtMs = patch.startedAtMs;
        }
        await paths.session(this.currentSessionId).set(patch, { merge: true });
    }

    async start() {
        if (!this.currentSessionId) throw new Error('no_session_loaded');
        if (this.state === STATES.ENDED) throw new Error('session_ended');
        if (this.state !== STATES.IDLE) {
            logWarn('orch', 'start_ignored', { state: this.state });
            return;
        }
        await this.#transitionTo(STATES.OPENING);
        await this.#runOpener();
        await this.#transitionTo(STATES.RUNNING);
        this.#startTick();
        logInfo('orch', 'started');
        this.#tryDrainAudienceQueue().catch(() => {});
    }

    async pause() {
        if (!LIVE_STATES.has(this.state) || this.state === STATES.PAUSED) return;
        this.#stopTick();
        await this.#transitionTo(STATES.PAUSED);
        logInfo('orch', 'paused');
    }

    async resume() {
        if (this.state !== STATES.PAUSED) return;
        await this.#transitionTo(STATES.RUNNING);
        this.#startTick();
        logInfo('orch', 'resumed');
        this.#tryDrainAudienceQueue().catch(() => {});
    }

    async updateSettings(patch) {
        const wasEnabled = !!this.settings.audienceGodotEnabled;
        this.settings = { ...this.settings, ...patch };
        await paths.session(this.currentSessionId).set({ settings: this.settings }, { merge: true });
        feed.publish({ type: 'settings', settings: this.settings });
        // If audience Godot was just turned on, attempt to drain whatever's queued.
        if (!wasEnabled && this.settings.audienceGodotEnabled) {
            this.#tryDrainAudienceQueue().catch(() => {});
        }
    }

    async updateProfile(id, patch) {
        const cur = this.profiles.get(id);
        if (!cur) throw new Error(`Unknown character: ${id}`);
        const next = { ...cur, ...patch, id };
        this.profiles.set(id, next);
        await paths.profile(this.currentSessionId, id).set(next, { merge: true });
        feed.publishProfiles(this.profileList());
    }

    // ---------- Tick ----------

    #startTick() {
        if (this.tickHandle) return;
        this.tickHandle = setInterval(
            () => this.#tick().catch((err) => logError('orch', 'tick_failed', { message: err.message })),
            config.defaults.triggerEvalIntervalMs,
        );
    }

    #stopTick() {
        if (this.tickHandle) {
            clearInterval(this.tickHandle);
            this.tickHandle = null;
        }
    }

    async #tick() {
        if (this.state !== STATES.RUNNING) return;
        if (this.generating) return;

        const now = Date.now();
        if (now - this.lastPostAt < this.settings.globalCooldownMs) return;

        this.recentTimestamps = this.recentTimestamps.filter((t) => now - t < 60_000);
        if (this.recentTimestamps.length >= this.settings.targetPostsPerMinute + 1) return;

        const eligible = this.profileList().filter((p) => {
            const last = this.lastPostByChar[p.id] || 0;
            return now - last >= this.settings.perCharacterCooldownMs;
        });
        if (!eligible.length) return;

        const winner = pickWinner(eligible, this.transcript.windowText(), this.lastPostByChar);
        if (!winner) return;

        await this.#generateAndPost(winner.profile);
    }

    async #generateAndPost(profile, extraInstruction = null) {
        if (this.generating) return;
        this.generating = true;
        this.#startTyping(profile);
        const t0 = Date.now();
        let committed = false;
        try {
            const all = this.recentPosts.slice(-config.defaults.recentChatPostsForContext);
            const ownRecent = all.filter((p) => p.characterId === profile.id).slice(-5);
            const othersRecent = all.filter((p) => p.characterId !== profile.id);
            const text = await generatePostFor(profile, {
                transcriptText: this.transcript.windowText(),
                ownRecent,
                othersRecent,
                extraInstruction,
            });
            const genMs = Date.now() - t0;
            const body = (text || '').trim();
            if (!body) {
                logWarn('orch', 'empty_generation', { character: profile.id, genMs });
                return;
            }
            if (isRepetitive(body, ownRecent)) {
                logWarn('orch', 'repetition_dropped', {
                    character: profile.id,
                    genMs,
                    draft: body,
                });
                return;
            }
            // Per-character artificial pause before committing. Lets you
            // pace characters independently of real model latency. Typing
            // dots stay visible through the pause.
            const pause = Math.max(0, Number(profile.responseDelayMs) || 0);
            if (pause > 0) await delay(pause);
            await this.#commitPost(profile, body, genMs);
            committed = true;
        } catch (err) {
            logError('orch', 'generation_failed', {
                character: profile.id,
                provider: profile.provider,
                message: err.message,
            });
        } finally {
            this.#endTyping();
            this.generating = false;
            // If this was a Godot generation and nothing committed, the
            // commit-driven scheduling never fires — schedule the recovery
            // here so the exchange isn't permanently stuck.
            if (!committed && this.godot.active) this.#godotRecoverAfterDrop();
        }
    }

    #godotRecoverAfterDrop() {
        this.godot.failedAttempts = (this.godot.failedAttempts || 0) + 1;
        const maxAttempts = (this.settings.godotDeliberationCap + 1) * 2;
        if (this.godot.failedAttempts >= maxAttempts) {
            logWarn('orch', 'godot_max_failed_attempts', { attempts: this.godot.failedAttempts });
            setTimeout(() => this.#endGodot().catch(() => {}), 0);
            return;
        }
        const retryDelay = 1500;
        if (this.godot.phase === 'answering') {
            logInfo('orch', 'godot_answer_dropped_retry', { failed: this.godot.failedAttempts });
            setTimeout(() => this.#fireGodotAnswer().catch(() => {}), retryDelay);
        } else {
            logInfo('orch', 'godot_deliberation_dropped_retry', { failed: this.godot.failedAttempts });
            setTimeout(() => this.#deliberateNext().catch(() => {}), retryDelay);
        }
    }

    #startTyping(profile) {
        this.currentTyping = {
            characterId: profile.id,
            displayName: profile.displayName,
            nickname: profile.nickname || null,
            avatarUrl: profile.avatarUrl || null,
            modelLabel: profile.modelLabel || profile.model,
            modelBadgeUrl: profile.modelBadgeUrl || null,
            startedAtMs: Date.now(),
        };
        feed.publish({ type: 'typing', typing: this.currentTyping });
    }

    #endTyping() {
        if (!this.currentTyping) return;
        const cid = this.currentTyping.characterId;
        this.currentTyping = null;
        feed.publish({ type: 'typing_end', characterId: cid });
    }

    async #commitPost(profile, body, genMs) {
        const now = Date.now();
        const post = {
            id: newId(),
            sessionId: this.currentSessionId,
            characterId: profile.id,
            displayName: profile.displayName,
            nickname: profile.nickname,
            provider: profile.provider,
            model: profile.model,
            modelLabel: profile.modelLabel,
            avatarUrl: profile.avatarUrl,
            modelBadgeUrl: profile.modelBadgeUrl,
            body,
            createdAtMs: now,
            createdAt: FieldValue.serverTimestamp(),
            genMs: typeof genMs === 'number' ? genMs : null,
            kind: this.godot.active ? 'godot_deliberation' : 'live',
        };
        await paths.post(this.currentSessionId, post.id).set(post);
        const wireSafe = serializeForFeed(post);
        this.recentPosts.push(wireSafe);
        if (this.recentPosts.length > 200) this.recentPosts.shift();
        this.lastPostAt = now;
        this.lastPostByChar[profile.id] = now;
        this.recentTimestamps.push(now);
        feed.publishPost(wireSafe);

        if (this.godot.active) {
            if (this.godot.phase === 'deliberating') {
                this.godot.deliberationCount += 1;
                if (this.godot.deliberationCount >= this.settings.godotDeliberationCap) {
                    this.godot.phase = 'answering';
                    // Defer so the outer #generateAndPost can clear its
                    // generating flag before #fireGodotAnswer's inner
                    // #generateAndPost call.
                    setTimeout(() => this.#fireGodotAnswer().catch(() => {}), 0);
                } else {
                    setTimeout(
                        () => this.#deliberateNext().catch(() => {}),
                        Math.max(1500, this.settings.globalCooldownMs / 2),
                    );
                }
            } else if (this.godot.phase === 'answering') {
                // The answer just committed — wind down the exchange.
                setTimeout(() => this.#endGodot().catch(() => {}), 0);
            }
        }
    }

    // ---------- Opener sequence ----------

    async #runOpener() {
        const gogo = this.profiles.get('estragon');
        await this.#commitPost(gogo, 'Nothing to be done.', null);
        await delay(2200);

        const beats = [
            {
                char: 'vladimir',
                instruction:
                    'Open with a brief, in-character acknowledgment: you are an AI, Estragon is also an AI, you are about to comment on the panel. One sentence. Plain prose.',
            },
            {
                char: 'pozzo',
                instruction:
                    'Introduce yourself in character, declamatory but brief. Acknowledge you are an AI and that you intend to outshine the other two. One short sentence.',
            },
            {
                char: 'estragon',
                instruction:
                    'In character, terse: complain mildly about being conscripted into commentary. One short fragment.',
            },
            {
                char: 'vladimir',
                instruction: 'In character, settle the tone: invite the panel to begin. One short sentence.',
            },
        ];
        for (const beat of beats) {
            const profile = this.profiles.get(beat.char);
            await this.#generateAndPost(profile, beat.instruction);
            await delay(2200);
        }
    }

    // ---------- Godot mode ----------

    async godotAsk(question, { source = 'operator', ip = null } = {}) {
        const q = (question || '').trim();
        if (!q) throw new Error('Empty Godot question');
        if (this.godot.active) throw new Error('Godot exchange already in progress');
        if (this.state !== STATES.RUNNING && this.state !== STATES.PAUSED) {
            throw new Error(`Cannot Godot in state ${this.state}`);
        }

        this.#stopTick();
        await this.#transitionTo(STATES.GODOT);
        this.godot = {
            active: true,
            question: q,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: 'deliberating',
            source,
        };

        const now = Date.now();
        const post = {
            id: newId(),
            sessionId: this.currentSessionId,
            characterId: 'godot',
            displayName: 'Godot',
            provider: 'human',
            model: 'human',
            modelLabel: source === 'visitor' ? 'Audience' : 'Operator',
            avatarUrl: null,
            modelBadgeUrl: null,
            body: q,
            createdAtMs: now,
            createdAt: FieldValue.serverTimestamp(),
            kind: 'godot_question',
            source,
            genMs: null,
        };
        await paths.post(this.currentSessionId, post.id).set(post);
        const wireSafe = serializeForFeed(post);
        this.recentPosts.push(wireSafe);
        feed.publishPost(wireSafe);
        logInfo('orch', 'godot_question', { question: q, source });

        await this.#deliberateNext();
    }

    // ---------- Audience Godot ----------

    enqueueAudienceGodot({ question, ip }) {
        if (!this.settings.audienceGodotEnabled) {
            const err = new Error('audience_godot_disabled');
            err.status = 403;
            throw err;
        }
        const q = (question || '').trim();
        if (!q) {
            const err = new Error('empty_question');
            err.status = 400;
            throw err;
        }
        const maxChars = Number(this.settings.audienceMaxChars) || 200;
        if (q.length > maxChars) {
            const err = new Error(`question_too_long_max_${maxChars}`);
            err.status = 400;
            throw err;
        }
        const now = Date.now();
        const rateLimitMs = Number(this.settings.audienceRateLimitMs) || 0;
        if (ip && rateLimitMs > 0) {
            const last = this.audienceRate.get(ip);
            if (last && now - last < rateLimitMs) {
                const err = new Error(
                    `rate_limited_retry_in_${Math.ceil((rateLimitMs - (now - last)) / 1000)}s`,
                );
                err.status = 429;
                throw err;
            }
        }
        const queueCap = Number(this.settings.audienceQueueCap) || 50;
        if (this.audienceQueue.length >= queueCap) {
            const err = new Error('queue_full');
            err.status = 429;
            throw err;
        }
        const item = {
            id: newId(),
            question: q,
            source: 'visitor',
            ip,
            queuedAtMs: now,
        };
        this.audienceQueue.push(item);
        if (ip) this.audienceRate.set(ip, now);
        this.#pruneRateMap(now);
        feed.publish({ type: 'audience_queue', count: this.audienceQueue.length });
        logInfo('orch', 'audience_godot_enqueued', { id: item.id, ip, length: q.length });
        // Best-effort drain.
        this.#tryDrainAudienceQueue().catch(() => {});
        return item;
    }

    clearAudienceQueue() {
        const n = this.audienceQueue.length;
        this.audienceQueue = [];
        feed.publish({ type: 'audience_queue', count: 0 });
        logInfo('orch', 'audience_queue_cleared', { dropped: n });
        return n;
    }

    dismissAudienceQueueItem(id) {
        const idx = this.audienceQueue.findIndex((q) => q.id === id);
        if (idx === -1) return false;
        this.audienceQueue.splice(idx, 1);
        feed.publish({ type: 'audience_queue', count: this.audienceQueue.length });
        return true;
    }

    async #tryDrainAudienceQueue() {
        if (!this.settings.audienceGodotEnabled) return;
        if (this.state !== STATES.RUNNING) return;
        if (this.godot.active) return;
        if (this.audienceQueue.length === 0) return;
        const next = this.audienceQueue.shift();
        feed.publish({ type: 'audience_queue', count: this.audienceQueue.length });
        try {
            await this.godotAsk(next.question, { source: 'visitor', ip: next.ip });
        } catch (err) {
            logError('orch', 'audience_drain_failed', {
                id: next.id,
                message: err.message,
            });
        }
    }

    #pruneRateMap(now) {
        for (const [ip, t] of this.audienceRate) {
            if (now - t > 5 * 60_000) this.audienceRate.delete(ip);
        }
    }

    async #deliberateNext() {
        if (!this.godot.active) return;
        if (this.godot.phase !== 'deliberating') return;

        const last = this.recentPosts.length
            ? this.recentPosts[this.recentPosts.length - 1].characterId
            : null;
        const candidates = this.profileList().filter((p) => p.id !== last);
        const pool = candidates.length ? candidates : this.profileList();
        const profile = pool[Math.floor(Math.random() * pool.length)];

        const remaining = this.settings.godotDeliberationCap - this.godot.deliberationCount;
        const instruction =
            `Godot has asked: "${this.godot.question}". You are deliberating with the other bots before one of you answers. ` +
            `Deliberation posts left including this one: ${remaining}. ` +
            `Stay in character. Briefly stake a position, push back on the other bots, or hand off. Plain prose, one short post.`;

        await this.#generateAndPost(profile, instruction);
    }

    async #fireGodotAnswer() {
        if (!this.godot.active) return;
        if (this.godot.phase !== 'answering') return;

        const winner =
            pickWinner(this.profileList(), this.godot.question, this.lastPostByChar) ||
            { profile: this.profiles.get('vladimir') };
        const answerProfile = winner.profile;

        const instruction =
            `Godot asked: "${this.godot.question}". The deliberation is over. You have been chosen to answer. ` +
            `Give the answer now, in character. Single short post, plain prose. Address the question directly.`;
        await this.#generateAndPost(answerProfile, instruction);
        // If commit succeeded, #commitPost schedules #endGodot.
        // If it dropped, #godotRecoverAfterDrop schedules a retry or gives up.
    }

    async #endGodot() {
        if (!this.godot.active) return;
        this.godot = {
            active: false,
            question: null,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: null,
            source: null,
        };
        await this.#transitionTo(STATES.RUNNING);
        this.#startTick();
        logInfo('orch', 'godot_resolved');
        // If audience queue has more questions, drain the next.
        this.#tryDrainAudienceQueue().catch(() => {});
    }

    // ---------- Rehearsal helpers ----------

    async probeCharacter(characterId, message, { includeContext = false } = {}) {
        const profile = this.profiles.get(characterId);
        if (!profile) throw new Error(`Unknown character: ${characterId}`);
        const transcriptText = includeContext ? this.transcript.windowText() : '';
        let ownRecent = [];
        let othersRecent = [];
        if (includeContext) {
            const all = this.recentPosts.slice(-config.defaults.recentChatPostsForContext);
            ownRecent = all.filter((p) => p.characterId === characterId).slice(-5);
            othersRecent = all.filter((p) => p.characterId !== characterId);
        }
        const extraInstruction = `Out-of-band rehearsal probe from the operator: "${message}". Reply in character, one short post. Plain prose.`;
        // Same builder the real generation uses — what the model "sees".
        const userMessage = buildUserMessage({
            transcriptText,
            ownRecent,
            othersRecent,
            extraInstruction,
            maxPostChars: profile.maxPostChars,
        });
        const t0 = Date.now();
        const text = await generatePostFor(profile, {
            transcriptText,
            ownRecent,
            othersRecent,
            extraInstruction,
        });
        return {
            characterId,
            text: (text || '').trim(),
            genMs: Date.now() - t0,
            model: profile.model,
            modelLabel: profile.modelLabel,
            provider: profile.provider,
            includedContext: includeContext,
            transcriptCharCount: transcriptText.length,
            recentChatCount: ownRecent.length + othersRecent.length,
            systemPrompt: profile.systemPrompt,
            userMessage,
        };
    }

    injectTranscript(text) {
        const t = (text || '').trim();
        if (!t) return;
        this.transcript.appendCompleted(t);
        feed.publish({ type: 'transcript_completed', text: t, at: Date.now(), source: 'injected' });
        logInfo('orch', 'transcript_injected', { chars: t.length });
    }

    // ---------- STT plumbing ----------

    onTranscriptDelta(text) {
        if (!text) return;
        feed.publish({ type: 'transcript_delta', text });
    }

    onTranscriptCompleted(text) {
        const t = (text || '').trim();
        if (!t) return;
        this.transcript.appendCompleted(t);
        feed.publish({ type: 'transcript_completed', text: t, at: Date.now() });
    }
}

const serializeForFeed = (post) => {
    const { createdAt, ...rest } = post;
    return {
        ...rest,
        createdAtMs:
            post.createdAtMs ||
            (post.createdAt?.toMillis ? post.createdAt.toMillis() : Date.now()),
    };
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns true if `candidate` is too similar to any of the character's
// last few own posts. Uses two cheap heuristics:
//   - Identical first 3 normalized words (catches "No festivals, no bread, …" → "No festivals, no bread, …")
//   - Jaccard similarity ≥ 0.5 on word sets (catches paraphrases)
const normalize = (s) =>
    (s || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);

const isRepetitive = (candidate, ownRecent) => {
    if (!ownRecent || !ownRecent.length) return false;
    const cTokens = normalize(candidate);
    if (cTokens.length < 3) return false;
    const cFirst3 = cTokens.slice(0, 3).join(' ');
    const cSet = new Set(cTokens);
    // Only compare against the most recent 3 own posts.
    for (const post of ownRecent.slice(-3)) {
        const pTokens = normalize(post.body);
        if (!pTokens.length) continue;
        if (pTokens.slice(0, 3).join(' ') === cFirst3) return true;
        const pSet = new Set(pTokens);
        const intersection = [...cSet].filter((t) => pSet.has(t)).length;
        const union = new Set([...cSet, ...pSet]).size;
        if (union && intersection / union >= 0.5) return true;
    }
    return false;
};

const wipeCollection = async (colRef) => {
    // Batch-delete all docs in a (small) collection. Adequate for rehearsal
    // session sizes — well under 500 docs typical.
    while (true) {
        const snap = await colRef.limit(400).get();
        if (snap.empty) return;
        const batch = colRef.firestore.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        if (snap.size < 400) return;
    }
};

export const orchestrator = new Orchestrator();
