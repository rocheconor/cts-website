// Gemini 3.1 Flash-Lite client (Generative AI SDK).

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { buildUserMessage, smartClip, maxTokensForChars } from './prompt.js';

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
    const model = getClient().getGenerativeModel({
        model: profile.model || config.models.gemini,
        systemInstruction: profile.systemPrompt,
        generationConfig: {
            maxOutputTokens: maxTokensForChars(profile.maxPostChars),
            temperature: 0.95,
        },
    });
    const userMessage = buildUserMessage({
        transcriptText,
        ownRecent,
        othersRecent,
        recentChat,
        extraInstruction,
        maxPostChars: profile.maxPostChars,
    });
    const response = await model.generateContent(userMessage);
    const text = response.response?.text?.() || '';
    return smartClip(text, profile.maxPostChars);
};
