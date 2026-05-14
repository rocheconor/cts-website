// Cheap heuristic trigger scoring per character.
//
// Score = keyword density * w.keyword + idle_minutes * w.recency + rand() * w.randomness.
// A character "fires" when score > profile.triggers.threshold and cooldowns allow.

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const keywordDensity = (text, keywords) => {
    const lower = (text || '').toLowerCase();
    if (!lower) return 0;
    const words = lower.split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    let hits = 0;
    for (const kw of keywords) {
        const re = new RegExp(`\\b${escapeRegex(kw.toLowerCase())}`, 'g');
        const matches = lower.match(re);
        if (matches) hits += matches.length;
    }
    // Scale density into roughly the unit range. Typical panel text in a
    // 5-minute window has hundreds of words; one or two hits ≈ ~0.3 after
    // this scaling.
    return Math.min(3, (hits / Math.max(40, words.length)) * 60);
};

const idleMinutes = (lastAt) => {
    if (!lastAt) return 2;
    return Math.min(3, (Date.now() - lastAt) / 60_000);
};

export const scoreCharacter = (profile, transcriptText, lastPostAt) => {
    const w = profile.triggers.weights || { keyword: 1, recency: 0.3, randomness: 0.15 };
    const k = keywordDensity(transcriptText, profile.triggers.keywords || []);
    const r = idleMinutes(lastPostAt);
    const noise = Math.random();
    return k * w.keyword + r * w.recency + noise * w.randomness;
};

export const pickWinner = (profiles, transcriptText, lastPostByChar) => {
    let best = null;
    for (const profile of profiles) {
        const score = scoreCharacter(profile, transcriptText, lastPostByChar[profile.id] || 0);
        if (score >= (profile.triggers.threshold ?? 1.0)) {
            if (!best || score > best.score) best = { profile, score };
        }
    }
    return best;
};
