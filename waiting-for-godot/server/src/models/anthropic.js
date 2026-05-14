// Claude Haiku 4.5 client. Single non-streaming Messages call per post.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { buildUserMessage, smartClip, maxTokensForChars } from './prompt.js';

let client = null;
const getClient = () => {
    if (!client) {
        if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not set');
        client = new Anthropic({ apiKey: config.anthropicApiKey });
    }
    return client;
};

export const generateAnthropicPost = async ({
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
    const response = await getClient().messages.create({
        model: profile.model || config.models.anthropic,
        max_tokens: maxTokensForChars(profile.maxPostChars),
        system: profile.systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
    });
    const block = response.content.find((b) => b.type === 'text');
    return smartClip(block?.text || '', profile.maxPostChars);
};
