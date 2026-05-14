// Shared user-message builder and smart clipper. Every provider's client
// uses the same shape so what a model "sees" is identical across providers.

export const buildUserMessage = ({
    transcriptText,
    ownRecent,
    othersRecent,
    recentChat, // legacy single bucket — used if own/others not provided
    extraInstruction,
    maxPostChars,
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
            'Post one short message reacting to the panel substance, in character. Plain prose, no quotes around your post, no role label. If a draft echoes any phrase or theme from your own recent posts above, scrap it and pick a different angle.',
    ];
    if (maxPostChars) {
        lines.push(
            `STRICT LIMIT: at most ${maxPostChars} characters in your reply. End at a complete sentence well under this cap. Do not run on.`,
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
