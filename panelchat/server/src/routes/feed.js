// Visitor-facing feed routes. No auth.
//   GET /panelchat-api/feed/initial[?sessionId=X]
//     - omit sessionId → currently active session (live)
//     - specific sessionId → that session, frozen (archive)
//   GET /panelchat-api/feed/stream[?sessionId=X]
//     - SSE; only streams live updates for the currently active session.
//       Archive requests get an immediate end-of-stream with no events.

import express from 'express';
import { orchestrator } from '../orchestrator/index.js';
import { feed } from '../orchestrator/feed.js';

export const feedRouter = express.Router();

feedRouter.get('/initial', async (req, res) => {
    const sessionId = req.query.sessionId;
    try {
        if (sessionId && sessionId !== orchestrator.currentSessionId) {
            const archive = await orchestrator.readSessionForArchive(sessionId);
            return res.json(archive);
        }
        res.json(orchestrator.initialState());
    } catch (err) {
        if (err.message === 'session_not_found') return res.status(404).json({ error: 'session_not_found' });
        res.status(500).json({ error: err.message });
    }
});

feedRouter.get('/stream', (req, res) => {
    const sessionId = req.query.sessionId;
    const isArchive = sessionId && sessionId !== orchestrator.currentSessionId;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (envelope) => {
        try {
            res.write(`data: ${JSON.stringify(envelope)}\n\n`);
        } catch {}
    };

    send({
        type: 'hello',
        state: isArchive ? null : orchestrator.initialState(),
        archive: !!isArchive,
        sessionId: sessionId || orchestrator.currentSessionId,
    });

    if (isArchive) {
        res.end();
        return;
    }

    const onEvent = (envelope) => send(envelope);
    feed.on('event', onEvent);

    const heartbeat = setInterval(() => {
        try {
            res.write(': hb\n\n');
        } catch {}
    }, 15_000);

    req.on('close', () => {
        clearInterval(heartbeat);
        feed.off('event', onEvent);
    });
});
