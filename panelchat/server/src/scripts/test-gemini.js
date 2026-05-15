// Smoke test: single generateContent call against gemini-3.1-flash-lite-preview.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';

const main = async () => {
    if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY not set in .env.local');
    const client = new GoogleGenerativeAI(config.geminiApiKey);
    const model = client.getGenerativeModel({
        model: config.models.gemini,
        systemInstruction: 'Reply in five words.',
    });
    const t0 = Date.now();
    const res = await model.generateContent('Say hi.');
    const text = res.response?.text?.() || '(no text)';
    console.log(`[ok] gemini ${config.models.gemini} in ${Date.now() - t0}ms`);
    console.log(`     → ${text}`);
};
main().catch((err) => { console.error('[fail]', err.message); process.exit(1); });
