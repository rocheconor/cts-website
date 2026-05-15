// Claude Haiku 4.5 client. Single non-streaming Messages call per post.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { buildUserMessage, smartClip, maxTokensForChars, composeWithSources } from './prompt.js';

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
    // Server-side web search is transparent: one API call, Anthropic runs
    // the search and bakes the result into the model's final text. Citations
    // arrive embedded in the text block — we instruct the model to format
    // them as `[title](url)` in the system/user prompts.
    const tools = webResearchEnabled
        ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
        : undefined;
    // Bump max_tokens modestly when research is on to leave room for cited URLs.
    const maxTokens = webResearchEnabled
        ? maxTokensForChars(profile.maxPostChars) + 200
        : maxTokensForChars(profile.maxPostChars);
    const response = await getClient().messages.create({
        model: profile.model || config.models.anthropic,
        max_tokens: maxTokens,
        system: profile.systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        ...(tools ? { tools } : {}),
    });
    // With a tool call, the response contains multiple blocks (text +
    // server_tool_use + web_search_tool_result + more text). Concatenate
    // every text block in order so the final assistant prose is what we
    // ship; extract citations from the web_search_tool_result blocks.
    const blocks = response.content || [];
    const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join('\n');
    const sources = appendSourcesLine(blocks);
    return composeWithSources(text, sources, profile.maxPostChars);
};

const appendSourcesLine = (blocks) => {
    const seen = new Map();
    for (const block of blocks) {
        // Anthropic web search returns hits inside `web_search_tool_result`
        // blocks (block.content[*] is an array of {type, title, url, ...}).
        // Some payloads also annotate inline text blocks with a `citations`
        // array — we honour both.
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
            for (const r of block.content) {
                const url = r.url;
                if (!url || seen.has(url)) continue;
                seen.set(url, r.title || urlHostname(url));
            }
        }
        if (block.type === 'text' && Array.isArray(block.citations)) {
            for (const c of block.citations) {
                const url = c.url || c.source?.url;
                if (!url || seen.has(url)) continue;
                seen.set(url, c.title || c.source?.title || urlHostname(url));
            }
        }
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
