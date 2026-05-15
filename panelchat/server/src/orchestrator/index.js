// Central orchestrator for panelchat. Owns the *currently loaded* session:
// its state, character profiles, cooldowns, trigger evaluation, post
// generation, and the audience-question deliberation cap.
//
// Multi-session model:
//   - panelchat_state/active doc holds the active sessionId — the one
//     /panelchat renders.
//   - Each panelchat_sessions/{id} doc holds its own state, settings,
//     profiles, posts, transcript, log.
//   - One orchestrator process holds at most one session loaded at a time.
//     Activating a different session pauses the prior one (if running) and
//     swaps in the new one. Ended sessions are terminal; deleted sessions
//     are wiped.

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
    QUESTION: 'question',
    ENDED: 'ended',
};

const LIVE_STATES = new Set([STATES.OPENING, STATES.RUNNING, STATES.PAUSED, STATES.QUESTION]);

const DEFAULT_SETTINGS = () => ({
    globalCooldownMs: config.defaults.globalCooldownMs,
    perCharacterCooldownMs: config.defaults.perCharacterCooldownMs,
    targetPostsPerMinute: config.defaults.targetPostsPerMinute,
    // After an audience question lands, the bots deliberate this many times
    // (one short post each) before one of them answers.
    deliberationCap: config.defaults.deliberationCap,
    // Audience Asks (live editable per session)
    audienceAsksEnabled: false,
    audienceRateLimitMs: 60_000, // per-IP cooldown between submissions
    audienceMaxChars: 200, // max chars per question
    audienceQueueCap: 50, // max items in queue
    // No regular posts when no transcript has arrived in this many ms.
    // 0 disables the gate. Audience/operator questions still go through.
    idleQuietMs: config.defaults.idleQuietMs,
});

export class Orchestrator {
    constructor() {
        this.currentSessionId = null;
        this.state = STATES.IDLE;
        this.profiles = new Map();
        this.transcript = new TranscriptBuffer({ persist: false });
        this.settings = DEFAULT_SETTINGS();
        this.session = null;

        this.lastPostAt = 0;
        this.lastPostByChar = Object.fromEntries(CHARACTERS.map((c) => [c, 0]));
        this.recentPosts = [];
        this.recentTimestamps = [];
        this.lastTranscriptAppendAtMs = 0;

        this.generating = false;
        this.tickHandle = null;
        this.question = {
            active: false,
            text: null,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: null, // 'deliberating' | 'answering' | null
            source: null,
        };

        this.audienceQueue = [];
        this.audienceRate = new Map();

        this.currentTyping = null;
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
        if (!['rehearsal', 'live'].includes(kind)) {
            throw new Error(`unknown_session_kind: ${kind}`);
        }
        const id = `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        await this.#createSessionDoc({ id, label, kind });
        await this.activateSession(id);
        return id;
    }

    async activateSession(sessionId) {
        if (this.currentSessionId === sessionId) return;
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
        if (persistedState === STATES.OPENING || persistedState === STATES.QUESTION) {
            this.state = STATES.PAUSED;
            await paths.session(sessionId).set({ state: STATES.PAUSED }, { merge: true });
            logInfo('orch', 'state_coerced_on_load', { from: persistedState, to: STATES.PAUSED });
        } else {
            this.state = persistedState;
        }
        this.settings = { ...DEFAULT_SETTINGS(), ...(meta.settings || {}) };

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

        const postsSnap = await paths
            .posts(sessionId)
            .orderBy('createdAtMs', 'desc')
            .limit(config.defaults.recentChatPostsForContext)
            .get();
        this.recentPosts = postsSnap.docs.map((d) => d.data()).reverse().map(serializeForFeed);

        this.transcript = new TranscriptBuffer({ persist: true, sessionId });
        this.lastPostAt = 0;
        this.lastPostByChar = Object.fromEntries(CHARACTERS.map((c) => [c, 0]));
        this.recentTimestamps = [];
        this.lastTranscriptAppendAtMs = 0;
        this.generating = false;
        this.question = {
            active: false,
            text: null,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: null,
            source: null,
        };

        feed.publish({ type: 'session_loaded', sessionId, state: this.state, session: this.session });
        feed.publishProfiles(this.profileList());

        logInfo('orch', 'loaded_session', { sessionId, label: meta.label, state: this.state });

        if (this.state === STATES.RUNNING) {
            this.#startTick();
        }
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
        await wipeCollection(paths.posts(sid));
        await wipeCollection(paths.transcript(sid));
        await paths.session(sid).set(
            { state: STATES.IDLE, startedAtMs: null, restartedAtMs: Date.now() },
            { merge: true },
        );
        this.transcript = new TranscriptBuffer({ persist: true, sessionId: sid });
        this.recentPosts = [];
        this.lastPostAt = 0;
        this.lastPostByChar = Object.fromEntries(CHARACTERS.map((c) => [c, 0]));
        this.recentTimestamps = [];
        this.lastTranscriptAppendAtMs = 0;
        this.generating = false;
        this.question = {
            active: false,
            text: null,
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
        await paths.session(sessionId).set(
            { state: STATES.ENDED, endedAtMs: Date.now(), endedAt: FieldValue.serverTimestamp() },
            { merge: true },
        );
        logInfo('orch', 'ended_remote', { sessionId });
    }

    async deleteSession(sessionId) {
        if (!sessionId) throw new Error('missing_session_id');
        if (sessionId === this.currentSessionId) {
            const err = new Error('cannot_delete_active_session');
            err.status = 400;
            throw err;
        }
        const docSnap = await paths.session(sessionId).get();
        if (!docSnap.exists) {
            const err = new Error('session_not_found');
            err.status = 404;
            throw err;
        }
        await wipeCollection(paths.posts(sessionId));
        await wipeCollection(paths.transcript(sessionId));
        await wipeCollection(paths.log(sessionId));
        await wipeCollection(paths.profiles(sessionId));
        await wipeCollection(paths.podcasts(sessionId));
        await paths.session(sessionId).delete();
        logInfo('orch', 'deleted_session', { sessionId });
        feed.publish({ type: 'session_deleted', sessionId });
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
        const wasEnabled = !!this.settings.audienceAsksEnabled;
        this.settings = { ...this.settings, ...patch };
        await paths.session(this.currentSessionId).set({ settings: this.settings }, { merge: true });
        feed.publish({ type: 'settings', settings: this.settings });
        if (!wasEnabled && this.settings.audienceAsksEnabled) {
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

    // Overwrite every character profile on the current session with the seed
    // defaults from profiles.js. Wipes any operator edits to display names,
    // system prompts, triggers, model selection, etc. Used after the seed
    // defaults change in code (e.g. revised prompts) to pull them into an
    // existing session without recreating it.
    async resetProfilesToDefaults() {
        if (!this.currentSessionId) throw new Error('no_session_loaded');
        const batch = paths.profiles(this.currentSessionId).firestore.batch();
        const seed = profileSeedArray();
        this.profiles.clear();
        for (const p of seed) {
            const fresh = { ...p };
            this.profiles.set(p.id, fresh);
            batch.set(paths.profile(this.currentSessionId, p.id), fresh);
        }
        await batch.commit();
        feed.publishProfiles(this.profileList());
        logInfo('orch', 'profiles_reset_to_defaults', {
            sessionId: this.currentSessionId,
            count: seed.length,
        });
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

        // Idle-quiet gate: stay silent when nothing is happening on the panel.
        // The opener already ran on Start; ticks resume only once transcript
        // segments start arriving (or once an operator injects text). Audience
        // questions bypass this — they don't go through #tick.
        const quiet = this.settings.idleQuietMs ?? 0;
        if (quiet > 0) {
            if (!this.lastTranscriptAppendAtMs) return;
            if (now - this.lastTranscriptAppendAtMs > quiet) return;
        }

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

    async #generateAndPost(profile, extraInstruction = null, { coldContext = false } = {}) {
        if (this.generating) return;
        this.generating = true;
        this.#startTyping(profile);
        const t0 = Date.now();
        let committed = false;
        try {
            // coldContext: true forces an empty transcript + no recent-posts
            // history into the user message. Used by the opener so prior
            // session content (or a stale rolling buffer) can't bleed into
            // the introductions.
            const all = coldContext
                ? []
                : this.recentPosts.slice(-config.defaults.recentChatPostsForContext);
            const ownRecent = all.filter((p) => p.characterId === profile.id).slice(-5);
            const othersRecent = all.filter((p) => p.characterId !== profile.id);
            const transcriptText = coldContext ? '' : this.transcript.windowText();
            const text = await generatePostFor(profile, {
                transcriptText,
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
            // Self-pass: ambient ticks invite the model to reply PASS when
            // it has nothing useful to add. Drop the post silently — the
            // operator sees this in the session log but visitors do not.
            // Question flows (opener, deliberation, answer) pass an explicit
            // extraInstruction that doesn't include the PASS option, so they
            // never end up here.
            if (isSelfPass(body)) {
                logInfo('orch', 'silent_pass', { character: profile.id, genMs });
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
            if (!committed && this.question.active) this.#questionRecoverAfterDrop();
        }
    }

    #questionRecoverAfterDrop() {
        this.question.failedAttempts = (this.question.failedAttempts || 0) + 1;
        const maxAttempts = (this.settings.deliberationCap + 1) * 2;
        if (this.question.failedAttempts >= maxAttempts) {
            logWarn('orch', 'question_max_failed_attempts', { attempts: this.question.failedAttempts });
            setTimeout(() => this.#endQuestion().catch(() => {}), 0);
            return;
        }
        const retryDelay = 1500;
        if (this.question.phase === 'answering') {
            logInfo('orch', 'answer_dropped_retry', { failed: this.question.failedAttempts });
            setTimeout(() => this.#fireAnswer().catch(() => {}), retryDelay);
        } else {
            logInfo('orch', 'deliberation_dropped_retry', { failed: this.question.failedAttempts });
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
            kind: this.question.active ? 'deliberation' : 'live',
        };
        await paths.post(this.currentSessionId, post.id).set(post);
        const wireSafe = serializeForFeed(post);
        this.recentPosts.push(wireSafe);
        if (this.recentPosts.length > 200) this.recentPosts.shift();
        this.lastPostAt = now;
        this.lastPostByChar[profile.id] = now;
        this.recentTimestamps.push(now);
        feed.publishPost(wireSafe);

        if (this.question.active) {
            if (this.question.phase === 'deliberating') {
                this.question.deliberationCount += 1;
                if (this.question.deliberationCount >= this.settings.deliberationCap) {
                    this.question.phase = 'answering';
                    setTimeout(() => this.#fireAnswer().catch(() => {}), 0);
                } else {
                    setTimeout(
                        () => this.#deliberateNext().catch(() => {}),
                        Math.max(1500, this.settings.globalCooldownMs / 2),
                    );
                }
            } else if (this.question.phase === 'answering') {
                setTimeout(() => this.#endQuestion().catch(() => {}), 0);
            }
        }
    }

    // ---------- Opener sequence ----------

    async #runOpener() {
        // For this single turn, we override the system prompt's
        // "no self-introduction" rule and tell each bot to introduce
        // itself in its natural voice. coldContext=true ensures no prior
        // transcript / posts leak into the opener and pollute the intros.
        const openerInstruction =
            'The session is starting and you have not posted yet. For this one turn only, introduce yourself: in one or two short sentences, in your natural voice, say which model you are and a brief sense of how you would approach commenting on a panel. Plain prose, no greeting like "Hello", no preamble. The "no self-introduction" rule in your usual instructions applies again from your next post onwards.';
        for (const char of ['anthropic', 'openai', 'gemini']) {
            const profile = this.profiles.get(char);
            if (!profile) continue;
            await this.#generateAndPost(profile, openerInstruction, { coldContext: true });
            await delay(2200);
        }
    }

    // ---------- Audience question mode ----------

    async askQuestion(question, { source = 'operator', ip = null } = {}) {
        const q = (question || '').trim();
        if (!q) throw new Error('Empty question');
        if (this.question.active) throw new Error('Question exchange already in progress');
        if (this.state !== STATES.RUNNING && this.state !== STATES.PAUSED) {
            throw new Error(`Cannot ask in state ${this.state}`);
        }

        this.#stopTick();
        await this.#transitionTo(STATES.QUESTION);
        this.question = {
            active: true,
            text: q,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: 'deliberating',
            source,
        };

        const now = Date.now();
        const post = {
            id: newId(),
            sessionId: this.currentSessionId,
            characterId: 'audience',
            displayName: source === 'operator' ? 'Operator' : 'Audience',
            provider: 'human',
            model: 'human',
            modelLabel: source === 'operator' ? 'Operator' : 'Audience',
            avatarUrl: null,
            modelBadgeUrl: null,
            body: q,
            createdAtMs: now,
            createdAt: FieldValue.serverTimestamp(),
            kind: source === 'operator' ? 'operator_question' : 'audience_question',
            source,
            genMs: null,
        };
        await paths.post(this.currentSessionId, post.id).set(post);
        const wireSafe = serializeForFeed(post);
        this.recentPosts.push(wireSafe);
        feed.publishPost(wireSafe);
        logInfo('orch', 'question', { question: q, source });

        await this.#deliberateNext();
    }

    // ---------- Audience Asks ----------

    async enqueueAudienceQuestion({ question, ip, forPanel = false }) {
        if (!this.settings.audienceAsksEnabled) {
            const err = new Error('audience_asks_disabled');
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
        // Panel-directed questions bypass the AI queue entirely. They post
        // straight to the feed so the operator (and the rest of the
        // audience) can see them; the bots do not deliberate.
        if (forPanel) {
            const post = {
                id: newId(),
                sessionId: this.currentSessionId,
                characterId: 'audience',
                displayName: 'Audience',
                provider: 'human',
                model: 'human',
                modelLabel: 'For panel',
                avatarUrl: null,
                modelBadgeUrl: null,
                body: q,
                createdAtMs: now,
                createdAt: FieldValue.serverTimestamp(),
                kind: 'panel_question',
                source: 'visitor',
                genMs: null,
            };
            await paths.post(this.currentSessionId, post.id).set(post);
            const wireSafe = serializeForFeed(post);
            this.recentPosts.push(wireSafe);
            if (ip) this.audienceRate.set(ip, now);
            this.#pruneRateMap(now);
            feed.publishPost(wireSafe);
            logInfo('orch', 'panel_question', { id: post.id, ip, length: q.length });
            return { id: post.id, forPanel: true };
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
        logInfo('orch', 'audience_enqueued', { id: item.id, ip, length: q.length });
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
        if (!this.settings.audienceAsksEnabled) return;
        if (this.state !== STATES.RUNNING) return;
        if (this.question.active) return;
        if (this.audienceQueue.length === 0) return;
        const next = this.audienceQueue.shift();
        feed.publish({ type: 'audience_queue', count: this.audienceQueue.length });
        try {
            await this.askQuestion(next.question, { source: 'visitor', ip: next.ip });
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
        if (!this.question.active) return;
        if (this.question.phase !== 'deliberating') return;

        const last = this.recentPosts.length
            ? this.recentPosts[this.recentPosts.length - 1].characterId
            : null;
        const candidates = this.profileList().filter((p) => p.id !== last);
        const pool = candidates.length ? candidates : this.profileList();
        const profile = pool[Math.floor(Math.random() * pool.length)];

        const remaining = this.settings.deliberationCap - this.question.deliberationCount;
        const evidenceAsked = isEvidenceQuestion(this.question.text);
        const baseInstruction =
            `A question has been asked OF YOU and the other AI models (not of the panel): "${this.question.text}". ` +
            `You are deliberating with the other models. Deliberation posts left including this one: ${remaining}. ` +
            `In your natural voice, ENGAGE with the question: stake a real position, offer a specific angle, push back on the others, or hand off with a concrete prompt for them. ` +
            `Do NOT say "I'd rather wait for the panel", "the question is too broad", "let the panellists answer", or anything similar. The audience explicitly asked the AI models — they want your take. ` +
            `Plain prose, one short post.`;
        const evidenceClause = evidenceAsked && profile.webResearchEnabled
            ? ` The question asks for EVIDENCE / DATA / SOURCES — you MUST use your web-search tool and cite at least one specific, real source in your post as [short title](url). A claim without a source here is failure.`
            : evidenceAsked
                ? ` The question asks for evidence / data / sources, but you do not have web-search enabled. Be honest that you are speaking from general knowledge, and let one of the other models with search take the citation.`
                : '';

        await this.#generateAndPost(profile, baseInstruction + evidenceClause);
    }

    async #fireAnswer() {
        if (!this.question.active) return;
        if (this.question.phase !== 'answering') return;

        // Prefer an answerer who didn't just deliberate, so a single
        // exchange doesn't end with the same model speaking twice in a row.
        // Falls back to the full pool if exclusion would empty it.
        const last = this.recentPosts.length
            ? this.recentPosts[this.recentPosts.length - 1].characterId
            : null;
        const fullPool = this.profileList();
        const fresh = fullPool.filter((p) => p.id !== last);
        const pool = fresh.length ? fresh : fullPool;
        const winner =
            pickWinner(pool, this.question.text, this.lastPostByChar) ||
            { profile: pool[0] };
        const answerProfile = winner.profile;

        const evidenceAsked = isEvidenceQuestion(this.question.text);
        const evidenceClause = evidenceAsked && answerProfile.webResearchEnabled
            ? ' The question asks for EVIDENCE / DATA / SOURCES — you MUST use your web-search tool and cite at least one specific, real source in your post as [short title](url). An answer without a source is failure here.'
            : evidenceAsked
                ? ' The question asks for evidence / data / sources. You do not have web-search enabled, so be honest that this is from general knowledge, give specific named studies or organisations where you can, and acknowledge the limit.'
                : ' If a credible source would strengthen your answer and you have web search available, use it.';
        const instruction =
            `Question: "${this.question.text}". The deliberation is over. You have been chosen to answer this question on behalf of the AI models. ` +
            `Answer it now, in your natural voice. Give your actual best answer — speculative or partial is fine; "it depends" is fine if you say what it depends on. ` +
            `Do NOT refuse to answer. Do NOT say "I'd rather wait for the panel" or "the question is too broad" or "let the panellists answer". The audience asked the AI models — give them an AI answer. ` +
            `Single short post, plain prose. Address the question directly.${evidenceClause}`;
        await this.#generateAndPost(answerProfile, instruction);
    }

    async #endQuestion() {
        if (!this.question.active) return;
        this.question = {
            active: false,
            text: null,
            deliberationCount: 0,
            failedAttempts: 0,
            phase: null,
            source: null,
        };
        await this.#transitionTo(STATES.RUNNING);
        this.#startTick();
        logInfo('orch', 'question_resolved');
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
        const userMessage = buildUserMessage({
            transcriptText,
            ownRecent,
            othersRecent,
            extraInstruction,
            maxPostChars: profile.maxPostChars,
            webResearchEnabled: !!profile.webResearchEnabled,
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
        this.lastTranscriptAppendAtMs = Date.now();
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
        this.lastTranscriptAppendAtMs = Date.now();
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

// Recognise the model's "I have nothing useful to add" signal. Accepts
// plain PASS, parenthesised (PASS), trailing punctuation, and the
// occasional model that wraps it ("PASS.", "Pass", "Pass.").
const isSelfPass = (s) => /^\(?\s*pass\s*\)?\s*[.!]?\s*$/i.test(s || '');

// Heuristic — does this question ask for evidence/data/sources? Used to
// strengthen the deliberation + answer prompts so a bot with web search
// can't get away with hand-wavy commentary when the audience explicitly
// asked for grounding.
const isEvidenceQuestion = (q) =>
    /\b(evidence|data|stats?|statistic|statistics|sources?|research|studies|stud(y|ies)|cite|citation|references?|proof|figures|numbers?|metric|metrics)\b/i.test(q || '');

const normalize = (s) =>
    (s || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);

const isRepetitive = (candidate, ownRecent) => {
    if (!ownRecent || !ownRecent.length) return false;
    const cTokens = normalize(candidate);
    if (cTokens.length < 3) return false;
    const cFirst3 = cTokens.slice(0, 3).join(' ');
    const cSet = new Set(cTokens);
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
