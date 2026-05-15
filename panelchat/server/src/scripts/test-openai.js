// Smoke test: three Chat Completions calls against gpt-5.4-mini with
// reasoning_effort='minimal' so we can see warm-up + steady-state latency.

import OpenAI from 'openai';
import { config } from '../config.js';

const main = async () => {
    if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY not set in .env.local');
    const client = new OpenAI({ apiKey: config.openaiApiKey });

    const runOnce = async (n) => {
        const t0 = Date.now();
        const res = await client.chat.completions.create({
            model: config.models.openai,
            max_completion_tokens: 60,
            reasoning_effort: 'none',
            messages: [
                { role: 'system', content: 'Reply in five words.' },
                { role: 'user', content: `Say hi (attempt ${n}).` },
            ],
        });
        const ms = Date.now() - t0;
        const text = res.choices?.[0]?.message?.content || '(no text)';
        console.log(`[#${n}] ${ms}ms  → ${text}`);
        return ms;
    };

    console.log(`[model] ${config.models.openai}  reasoning_effort=none`);
    const t1 = await runOnce(1);
    const t2 = await runOnce(2);
    const t3 = await runOnce(3);
    const avg = Math.round((t1 + t2 + t3) / 3);
    console.log(`[avg]   ${avg}ms (first call usually includes cold-start)`);
};
main().catch((err) => { console.error('[fail]', err.message); process.exit(1); });
