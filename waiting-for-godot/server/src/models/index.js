// Provider router: routes a character's generation request to its provider.

import { generateAnthropicPost } from './anthropic.js';
import { generateOpenAIPost } from './openai.js';
import { generateGeminiPost } from './gemini.js';

const PROVIDERS = {
    anthropic: generateAnthropicPost,
    openai: generateOpenAIPost,
    gemini: generateGeminiPost,
};

export const generatePostFor = async (profile, args) => {
    const fn = PROVIDERS[profile.provider];
    if (!fn) throw new Error(`Unknown provider: ${profile.provider}`);
    return fn({ profile, ...args });
};
