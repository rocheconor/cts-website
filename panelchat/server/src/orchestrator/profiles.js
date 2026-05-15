// Seed character profiles for panelchat. Three slots, keyed by provider so
// the slot id reads naturally in code. Each slot has its own model,
// system prompt, trigger keywords, and avatar. All editable per-session
// from the admin — these are just the starting values for a new session.
//
// Voice philosophy: prompts are deliberately minimal. We want each model
// to sound like its off-the-shelf self (Claude / GPT / Gemini as users
// experience them in the wild), not a costumed persona. The only firm
// constraints are length, plain prose, and no greeting / sign-off / role
// narration. Trigger keywords still nudge who tends to fire when — those
// are bookkeeping, not character.

export const CHARACTERS = ['anthropic', 'openai', 'gemini'];

// The per-character `maxPostChars` field on each profile is the source of
// truth for length. It's admin-editable and enforced dynamically at
// generation time (see prompt.js — appends a `STRICT LIMIT` line to the
// user message). The system prompt deliberately does NOT embed a number,
// so changing maxPostChars in the admin doesn't conflict with what the
// model has been told here.
const SHARED_PROMPT = `You are listening to a live panel discussion. Two other AI models are on the same backchannel. When it's your turn, post a short comment on what the panel just said — in your natural voice, the way you would normally answer this kind of prompt.

Rules:
- Single short post. Plain prose. No lists, no headers, no bold/italic markdown. The ONLY exception is inline links in markdown format: [short title](url) — those are allowed when you're citing a source.
- Keep it brief. A character limit will be supplied separately at each turn — stay well under it and end at a complete sentence.
- Do not introduce yourself. Do not greet, do not sign off, do not narrate your role.
- React to the panel substance, or to the other models' recent posts where it adds something.
- If a draft echoes a phrase or theme from your own recent posts, scrap it and pick a different angle.`;

const SHARED_MAX_POST_CHARS = 280;

export const DEFAULT_PROFILES = {
    anthropic: {
        id: 'anthropic',
        displayName: 'Claude',
        nickname: null,
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        modelLabel: 'Claude Haiku 4.5',
        avatarUrl: '/panelchat/assets/brand/anthropic.png',
        modelBadgeUrl: '/panelchat/assets/brand/anthropic.png',
        maxPostChars: SHARED_MAX_POST_CHARS,
        // Artificial pause after generation completes, before the post is
        // published. Independent of LLM latency. 0 = immediate.
        responseDelayMs: 0,
        // When true, the provider's native web-search/grounding tool is
        // attached at call time and the prompt invites citations. Default
        // off — operator opts in per-character from the admin Characters
        // panel.
        webResearchEnabled: false,
        triggers: {
            keywords: [
                'idea', 'thought', 'reason', 'meaning', 'purpose', 'why',
                'history', 'memory', 'future', 'philosophy', 'principle',
                'argument', 'evidence', 'claim',
            ],
            weights: { keyword: 1.0, recency: 0.4, randomness: 0.15 },
            threshold: 1.1,
        },
        systemPrompt: SHARED_PROMPT,
    },

    openai: {
        id: 'openai',
        displayName: 'GPT',
        nickname: null,
        provider: 'openai',
        model: 'gpt-5.4-mini-2026-03-17',
        modelLabel: 'GPT-5.4 mini',
        avatarUrl: '/panelchat/assets/brand/openai.png',
        modelBadgeUrl: '/panelchat/assets/brand/openai.png',
        // GPT is seeded as the "research citer" of the trio: longer posts so
        // citations fit, and web search on by default. Cleanest inline
        // [title](url) output of the three providers. Operator can flip
        // any of this in the admin Characters panel.
        maxPostChars: 600,
        responseDelayMs: 0,
        webResearchEnabled: true,
        triggers: {
            keywords: [
                'now', 'example', 'concrete', 'fact', 'data', 'number',
                'cost', 'time', 'today', 'tomorrow', 'real', 'practical',
                'specific', 'actually', 'literally', 'this',
            ],
            weights: { keyword: 1.1, recency: 0.6, randomness: 0.25 },
            threshold: 1.0,
        },
        systemPrompt: SHARED_PROMPT,
    },

    gemini: {
        id: 'gemini',
        displayName: 'Gemini',
        nickname: null,
        provider: 'gemini',
        model: 'gemini-3.1-flash-lite-preview',
        modelLabel: 'Gemini 3.1 Flash-Lite',
        avatarUrl: '/panelchat/assets/brand/gemini.png',
        modelBadgeUrl: '/panelchat/assets/brand/gemini.png',
        maxPostChars: SHARED_MAX_POST_CHARS,
        responseDelayMs: 0,
        webResearchEnabled: false,
        triggers: {
            keywords: [
                'market', 'business', 'value', 'cost', 'power', 'industry',
                'company', 'system', 'incentive', 'scale', 'leverage',
                'risk', 'opportunity', 'strategy', 'change',
            ],
            weights: { keyword: 1.0, recency: 0.5, randomness: 0.2 },
            threshold: 1.05,
        },
        systemPrompt: SHARED_PROMPT,
    },
};

export const profileSeedArray = () => CHARACTERS.map((id) => DEFAULT_PROFILES[id]);
