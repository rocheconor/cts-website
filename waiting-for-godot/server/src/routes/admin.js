// Admin routes. Cookie-gated; single shared password.

import express from 'express';
import {
    checkPassword,
    issueAdminCookie,
    clearAdminCookie,
    requireAdmin,
    isAuthenticated,
} from '../lib/auth.js';
import { orchestrator } from '../orchestrator/index.js';
import { paths } from '../lib/firestore.js';
import { logInfo, logWarn } from '../lib/log.js';

export const adminRouter = express.Router();

adminRouter.get('/status', (req, res) => {
    res.json({ authenticated: isAuthenticated(req) });
});

adminRouter.post('/login', (req, res) => {
    const password = req.body?.password;
    if (!checkPassword(password)) {
        logWarn('admin', 'login_failed');
        return res.status(401).json({ error: 'invalid_password' });
    }
    issueAdminCookie(res);
    logInfo('admin', 'login_ok');
    res.json({ ok: true });
});

adminRouter.post('/logout', (_req, res) => {
    clearAdminCookie(res);
    res.json({ ok: true });
});

// Everything below requires the admin cookie.
adminRouter.use(requireAdmin);

// ---------- Session lifecycle ----------

adminRouter.get('/sessions', async (_req, res) => {
    try {
        const sessions = await orchestrator.listSessions();
        res.json({ sessions, activeId: orchestrator.currentSessionId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

adminRouter.post('/sessions', async (req, res) => {
    const label = (req.body?.label || '').trim() || 'Untitled';
    const kind = req.body?.kind === 'live' ? 'live' : 'rehearsal';
    try {
        const id = await orchestrator.newSession({ label, kind });
        res.json({ ok: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

adminRouter.post('/sessions/:id/activate', async (req, res) => {
    try {
        await orchestrator.activateSession(req.params.id);
        res.json({ ok: true, activeId: orchestrator.currentSessionId });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/sessions/:id/end', async (req, res) => {
    try {
        await orchestrator.endSession(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------- Active session controls ----------

adminRouter.post('/start', async (_req, res) => {
    try {
        await orchestrator.start();
        res.json({ ok: true, state: orchestrator.state });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/end', async (_req, res) => {
    await orchestrator.endCurrentSession();
    res.json({ ok: true, state: orchestrator.state });
});

adminRouter.post('/restart', async (_req, res) => {
    try {
        await orchestrator.restartCurrentSession();
        res.json({ ok: true, state: orchestrator.state });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/pause', async (_req, res) => {
    await orchestrator.pause();
    res.json({ ok: true, state: orchestrator.state });
});

adminRouter.post('/resume', async (_req, res) => {
    await orchestrator.resume();
    res.json({ ok: true, state: orchestrator.state });
});

adminRouter.post('/godot', async (req, res) => {
    const question = req.body?.question;
    try {
        await orchestrator.godotAsk(question);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/settings', async (req, res) => {
    const numbers = [
        'globalCooldownMs',
        'perCharacterCooldownMs',
        'targetPostsPerMinute',
        'godotDeliberationCap',
        'audienceRateLimitMs',
        'audienceMaxChars',
        'audienceQueueCap',
    ];
    const booleans = ['audienceGodotEnabled'];
    const patch = {};
    for (const k of numbers) {
        if (req.body?.[k] !== undefined) patch[k] = Number(req.body[k]);
    }
    for (const k of booleans) {
        if (req.body?.[k] !== undefined) patch[k] = !!req.body[k];
    }
    await orchestrator.updateSettings(patch);
    res.json({ ok: true, settings: orchestrator.settings });
});

adminRouter.post('/profiles/:id', async (req, res) => {
    const allowed = [
        'displayName', 'nickname', 'avatarUrl', 'modelBadgeUrl', 'modelLabel',
        'maxPostChars', 'responseDelayMs', 'systemPrompt', 'triggers',
    ];
    const patch = {};
    for (const k of allowed) {
        if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    try {
        await orchestrator.updateProfile(req.params.id, patch);
        res.json({
            ok: true,
            profile: orchestrator.profileList().find((p) => p.id === req.params.id),
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.get('/profiles', (_req, res) => {
    res.json({ profiles: orchestrator.profileList() });
});

// ---------- Rehearsal tooling ----------

adminRouter.post('/probe', async (req, res) => {
    const characterId = req.body?.characterId;
    const message = req.body?.message;
    const includeContext = !!req.body?.includeContext;
    if (!characterId || !message) return res.status(400).json({ error: 'characterId and message required' });
    try {
        const result = await orchestrator.probeCharacter(characterId, message, { includeContext });
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

adminRouter.get('/audience-queue', (_req, res) => {
    res.json({
        enabled: !!orchestrator.settings.audienceGodotEnabled,
        items: orchestrator.audienceQueueSnapshot(),
    });
});

adminRouter.post('/audience-queue/clear', (_req, res) => {
    const dropped = orchestrator.clearAudienceQueue();
    res.json({ ok: true, dropped });
});

adminRouter.post('/audience-queue/dismiss/:id', (req, res) => {
    const removed = orchestrator.dismissAudienceQueueItem(req.params.id);
    res.json({ ok: true, removed });
});

adminRouter.post('/transcript-inject', async (req, res) => {
    const text = req.body?.text;
    if (!text) return res.status(400).json({ error: 'text required' });
    orchestrator.injectTranscript(text);
    res.json({ ok: true });
});

// ---------- Log ----------

adminRouter.get('/log', async (req, res) => {
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 200));
    const sid = req.query.sessionId || orchestrator.currentSessionId;
    if (!sid) return res.json({ entries: [] });
    const snap = await paths.log(sid).orderBy('createdAtMs', 'desc').limit(limit).get();
    res.json({
        sessionId: sid,
        entries: snap.docs.map((d) => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: undefined,
            };
        }),
    });
});

// ---------- Audio source ----------

adminRouter.get('/audio', (req, res) => {
    res.json({
        status: req.app.locals.audio.status(),
        devFiles: req.app.locals.audio.listDevAudio(),
    });
});

adminRouter.post('/audio/live', async (req, res) => {
    try {
        await req.app.locals.audio.startLive();
        res.json({ ok: true, status: req.app.locals.audio.status() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

adminRouter.post('/audio/file', async (req, res) => {
    const filename = req.body?.filename;
    try {
        await req.app.locals.audio.startFile(filename);
        res.json({ ok: true, status: req.app.locals.audio.status() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/audio/stop', async (req, res) => {
    await req.app.locals.audio.stop();
    res.json({ ok: true, status: req.app.locals.audio.status() });
});
