// Public visitor-facing audience routes. No auth.
//   POST /wfg-api/audience/godot — submit a question to the queue.

import express from 'express';
import { orchestrator } from '../orchestrator/index.js';

export const audienceRouter = express.Router();

audienceRouter.post('/godot', (req, res) => {
    const question = req.body?.question;
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    try {
        const item = orchestrator.enqueueAudienceGodot({ question, ip });
        res.json({
            ok: true,
            id: item.id,
            position: orchestrator.audienceQueueSnapshot().findIndex((q) => q.id === item.id) + 1,
            queueLength: orchestrator.audienceQueueSnapshot().length,
        });
    } catch (err) {
        const status = err.status || 500;
        res.status(status).json({ error: err.message });
    }
});
