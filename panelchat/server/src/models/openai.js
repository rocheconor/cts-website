// GPT-5.4 mini client (Chat Completions).

import OpenAI from 'openai';
import { config } from '../config.js';
import { buildUserMessage, smartClip, maxTokensForChars, composeWithSources } from './prompt.js';

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
    const webResearchEnabled = !!profile.webResearchEnabled;
    const userMessage = buildUserMessage({
        transcriptText,
        ownRecent,
        othersRecent,
        recentChat,
        extraInstruction,
        maxPostChars: profile.maxPostChars,
        webResearchEnabled,
    });
    // Web search is a Responses API feature on OpenAI — Chat Completions
    // doesn't accept tools: [{type: 'web_search'}]. So when research is on
    // we route the call through responses.create; otherwise stay on the
    // existing chat.completions path that supports reasoning_effort and
    // frequency/presence penalties.
    if (webResearchEnabled) {
        return generateOpenAIPostWithSearch({ profile, userMessage });
    }
    return generateOpenAIPostPlain({ profile, userMessage });
};

const generateOpenAIPostPlain = async ({ profile, userMessage }) => {
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
    return composeWithSources(text, '', profile.maxPostChars);
};

const generateOpenAIPostWithSearch = async ({ profile, userMessage }) => {
    const response = await getClient().responses.create({
        model: profile.model || config.models.openai,
        max_output_tokens: maxTokensForChars(profile.maxPostChars) + 200,
        tools: [{ type: 'web_search' }],
        instructions: profile.systemPrompt,
        input: userMessage,
    });
    // The Responses API exposes a convenience accessor: response.output_text
    // plus a structured response.output array with citations in
    // `content[*].annotations[*]` of type 'url_citation'.
    const text = response.output_text || extractResponsesText(response.output) || '';
    const annotations = extractResponsesAnnotations(response.output);
    const sources = annotationsToSourcesLine(annotations);
    return composeWithSources(text, sources, profile.maxPostChars);
};

const extractResponsesText = (output) => {
    if (!Array.isArray(output)) return '';
    const chunks = [];
    for (const item of output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
                if (c.type === 'output_text' && typeof c.text === 'string') {
                    chunks.push(c.text);
                }
            }
        }
    }
    return chunks.join('\n');
};

const extractResponsesAnnotations = (output) => {
    if (!Array.isArray(output)) return [];
    const out = [];
    for (const item of output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
                if (Array.isArray(c.annotations)) out.push(...c.annotations);
            }
        }
    }
    return out;
};

const annotationsToSourcesLine = (annotations) => {
    const seen = new Map();
    for (const a of annotations) {
        if (a.type !== 'url_citation') continue;
        const c = a.url_citation || a;
        const url = c.url;
        if (!url || seen.has(url)) continue;
        seen.set(url, c.title || urlHostname(url));
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
