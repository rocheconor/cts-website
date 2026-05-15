// Shared user-message builder and smart clipper. Every provider's client
// uses the same shape so what a model "sees" is identical across providers.

export const buildUserMessage = ({
    transcriptText,
    ownRecent,
    othersRecent,
    recentChat, // legacy single bucket — used if own/others not provided
    extraInstruction,
    maxPostChars,
    webResearchEnabled = false,
}) => {
    // Split chat into "your own" vs "from others" if both are provided;
    // otherwise treat `recentChat` as undifferentiated and label it as
    // backchannel-from-others (no self anchoring).
    const own = ownRecent || [];
    const others = othersRecent || recentChat || [];

    const ownLines = own.map((p) => `${p.displayName}: ${p.body}`).join('\n');
    const otherLines = others.map((p) => `${p.displayName}: ${p.body}`).join('\n');

    const lines = [
        'You are listening to a live panel discussion. Recent panel transcript (most recent at bottom):',
        '---',
        transcriptText || '(no panel audio yet — the panel has not started)',
        '---',
        'Other bots\' recent backchannel posts (most recent at bottom — you may respond, riff, or disagree):',
        otherLines || '(no posts from other bots yet)',
        '---',
        'Your OWN recent posts (do NOT repeat, paraphrase, or rehash these — cover new ground each turn):',
        ownLines || '(you have not posted recently)',
        '---',
        extraInstruction ||
            // Default "ambient tick" instruction: invites the model to decide
            // whether it actually has something useful to say. If not, the
            // model replies with the single word PASS and the orchestrator
            // drops the post silently. Question flows pass their own
            // extraInstruction and skip this path entirely.
            'Read the panel transcript and the other models\' recent posts above. Only post if you have something genuinely useful or interesting to add right now — a real reaction, a sharp counter, a concrete example. If you have nothing useful to add at this moment, reply with ONLY the single word: PASS. Most ticks should be PASS — silence is the default; only post when it would meaningfully add to the discussion. When you do post: plain prose, no quotes around your post, no role label, no preface. Do not echo a phrase or theme from your own recent posts above.',
    ];
    if (webResearchEnabled) {
        // Research-mode addendum. Only appended when the profile has web
        // research enabled — the model is given the option to search and
        // cite. PASS still wins over a thin citation.
        lines.push(
            'RESEARCH MODE: when the panel touches a topic where a credible source, statistic, or report would genuinely extend the argument, use your web-search tool to look it up and cite it. Inline markdown link format only: [short title](url). Only cite when it adds real value — do not pad a thin point with a search. The PASS rule still applies: silence beats a thin citation.',
        );
    }
    if (maxPostChars) {
        lines.push(
            `STRICT LIMIT: at most ${maxPostChars} characters in your reply (including any markdown links). End at a complete sentence well under this cap. Do not run on.`,
        );
    }
    return lines.join('\n');
};

// Smart clipper. If the model overran maxPostChars, prefer to end at the
// last complete sentence; else the last word boundary; only hard-cut with
// an ellipsis as a last resort.
export const smartClip = (text, maxChars) => {
    const t = (text || '').trim();
    if (!maxChars || t.length <= maxChars) return t;

    const window = t.slice(0, maxChars);
    // Try to end at the last sentence-terminating punctuation in the window.
    const sentenceMatch = window.match(/^[\s\S]*[.!?…](?=[\s"'”’)\]]*$|[\s"'”’)\]]+)/);
    if (sentenceMatch) {
        const end = sentenceMatch[0].length;
        if (end >= Math.min(40, Math.floor(maxChars * 0.4))) {
            return window.slice(0, end).trimEnd();
        }
    }
    // Fall back to last sentence break anywhere in the window.
    const lastSentence = Math.max(
        window.lastIndexOf('.'),
        window.lastIndexOf('!'),
        window.lastIndexOf('?'),
        window.lastIndexOf('…'),
    );
    if (lastSentence >= Math.min(40, Math.floor(maxChars * 0.4))) {
        return window.slice(0, lastSentence + 1).trimEnd();
    }
    // Fall back to last whitespace.
    const lastSpace = window.lastIndexOf(' ');
    if (lastSpace >= Math.min(20, Math.floor(maxChars * 0.3))) {
        return window.slice(0, lastSpace).trimEnd() + '…';
    }
    // Last resort: hard cut with ellipsis.
    return window.trimEnd() + '…';
};

// Convert a character budget to a token budget. ~3 chars/token is
// conservative for English; pad +20 so the cap is the limiter, not max_tokens.
export const maxTokensForChars = (maxPostChars) =>
    Math.max(40, Math.ceil((maxPostChars || 280) / 3) + 20);

// Combine the model's prose with an appended "Sources: …" markdown-link
// line, reserving room for the sources within the overall post budget.
// If there are no sources, falls back to the plain smartClip.
export const composeWithSources = (text, sources, maxChars) => {
    const body = (text || '').trim();
    if (!sources) return smartClip(body, maxChars);
    const sep = '\n\n';
    const reserve = sources.length + sep.length;
    const bodyBudget = Math.max(60, (maxChars || 280) - reserve);
    return smartClip(body, bodyBudget) + sep + sources;
};
