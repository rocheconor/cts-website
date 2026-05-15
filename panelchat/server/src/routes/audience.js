// Public visitor-facing audience routes. No auth.
//   POST /panelchat-api/audience/question — submit a question to the queue.

import express from 'express';
import { orchestrator } from '../orchestrator/index.js';

export const audienceRouter = express.Router();

audienceRouter.post('/question', async (req, res) => {
    const question = req.body?.question;
    const forPanel = !!req.body?.forPanel;
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    try {
        const item = await orchestrator.enqueueAudienceQuestion({ question, ip, forPanel });
        if (item.forPanel) {
            // Panel-directed: posts straight to the feed for the operator
            // (and audience) to see; no AI processing.
            return res.json({ ok: true, id: item.id, forPanel: true });
        }
        res.json({
            ok: true,
            id: item.id,
            forPanel: false,
            position: orchestrator.audienceQueueSnapshot().findIndex((q) => q.id === item.id) + 1,
            queueLength: orchestrator.audienceQueueSnapshot().length,
        });
    } catch (err) {
        const status = err.status || 500;
        res.status(status).json({ error: err.message });
    }
});
