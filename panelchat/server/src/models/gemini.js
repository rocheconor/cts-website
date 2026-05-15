// Gemini 3.1 Flash-Lite client (Generative AI SDK).

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { buildUserMessage, smartClip, maxTokensForChars, composeWithSources } from './prompt.js';

let client = null;
const getClient = () => {
    if (!client) {
        if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY not set');
        client = new GoogleGenerativeAI(config.geminiApiKey);
    }
    return client;
};

export const generateGeminiPost = async ({
    profile,
    transcriptText,
    ownRecent,
    othersRecent,
    recentChat,
    extraInstruction,
}) => {
    const webResearchEnabled = !!profile.webResearchEnabled;
    const maxOutputTokens = webResearchEnabled
        ? maxTokensForChars(profile.maxPostChars) + 200
        : maxTokensForChars(profile.maxPostChars);
    const model = getClient().getGenerativeModel({
        model: profile.model || config.models.gemini,
        systemInstruction: profile.systemPrompt,
        generationConfig: {
            maxOutputTokens,
            temperature: 0.95,
        },
        // Gemini's native Google Search grounding tool. Server-side; the
        // model picks up real search results and embeds citations in the
        // generated text (we ask it to use markdown link format in the
        // prompt).
        ...(webResearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
    });
    const userMessage = buildUserMessage({
        transcriptText,
        ownRecent,
        othersRecent,
        recentChat,
        extraInstruction,
        maxPostChars: profile.maxPostChars,
        webResearchEnabled,
    });
    const response = await model.generateContent(userMessage);
    const text = response.response?.text?.() || '';
    // Gemini's Google Search grounding attaches groundingMetadata on the
    // candidate with `groundingChunks: [{ web: { uri, title } }]`. Surface
    // them as a clickable "Sources:" line.
    const candidate = response.response?.candidates?.[0];
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = appendSourcesLine(chunks);
    return composeWithSources(text, sources, profile.maxPostChars);
};

const appendSourcesLine = (chunks) => {
    const seen = new Map();
    for (const c of chunks) {
        const w = c.web || c.retrievedContext || {};
        const url = w.uri || w.url;
        if (!url || seen.has(url)) continue;
        seen.set(url, w.title || urlHostname(url));
    }
    if (!seen.size) return '';
    const top = [...seen.entries()].slice(0, 3);
    return 'Sources: ' + top.map(([u, t]) => `[${t}](${u})`).join(' · ');
};

const urlHostname = (u) => {
    try {
        return new URL(u).hostname.replace(/^www\./, '');
    } catch {
        return u;
    }
};
