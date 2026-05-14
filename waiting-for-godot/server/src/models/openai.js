// GPT-5.4 mini client (Chat Completions).

import OpenAI from 'openai';
import { config } from '../config.js';
import { buildUserMessage, smartClip, maxTokensForChars } from './prompt.js';

let client = null;
const getClient = () => {
    if (!client) {
        if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY not set');
        client = new OpenAI({ apiKey: config.openaiApiKey });
    }
    return client;
};

export const generateOpenAIPost = async ({
    profile,
    transcriptText,
    ownRecent,
    othersRecent,
    recentChat,
    extraInstruction,
}) => {
    const userMessage = buildUserMessage({
        transcriptText,
        ownRecent,
        othersRecent,
        recentChat,
        extraInstruction,
        maxPostChars: profile.maxPostChars,
    });
    const response = await getClient().chat.completions.create({
        model: profile.model || config.models.openai,
        max_completion_tokens: maxTokensForChars(profile.maxPostChars),
        // 'none' skips reasoning-token spend; brief says speed > depth.
        // gpt-5.4-mini supported values: none | low | medium | high | xhigh.
        reasoning_effort: 'none',
        // Discourage word- and theme-level repetition across recent posts.
        frequency_penalty: 0.5,
        presence_penalty: 0.3,
        messages: [
            { role: 'system', content: profile.systemPrompt },
            { role: 'user', content: userMessage },
        ],
    });
    const text = response.choices?.[0]?.message?.content || '';
    return smartClip(text, profile.maxPostChars);
};
