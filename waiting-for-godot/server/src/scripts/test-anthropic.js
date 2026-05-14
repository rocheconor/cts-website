// Smoke test: single Anthropic Messages call against the pinned snapshot.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const main = async () => {
    if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not set in .env.local');
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const t0 = Date.now();
    const res = await client.messages.create({
        model: config.models.anthropic,
        max_tokens: 60,
        system: 'Reply in five words.',
        messages: [{ role: 'user', content: 'Say hi as Vladimir from Beckett.' }],
    });
    const text = res.content.find((b) => b.type === 'text')?.text || '(no text)';
    console.log(`[ok] anthropic ${config.models.anthropic} in ${Date.now() - t0}ms`);
    console.log(`     → ${text}`);
};
main().catch((err) => { console.error('[fail]', err.message); process.exit(1); });
