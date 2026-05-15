// Centralised env config for panelchat. Every other module reads from here,
// not process.env.

const required = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env: ${name}`);
    return v;
};

const optional = (name, fallback) => process.env[name] ?? fallback;

export const config = {
    // Cloud Run sets PORT=8080 by default; honour it. Local dev defaults
    // to 8788 to leave 8787 free for any sibling dev process.
    port: Number(optional('PORT', '8788')),
    sessionId: optional('SESSION_ID', 'panelchat-default'),
    publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:8788'),

    adminPassword: required('ADMIN_PASSWORD'),
    cookieSecret: required('SESSION_COOKIE_SECRET'),

    anthropicApiKey: optional('ANTHROPIC_API_KEY'),
    openaiApiKey: optional('OPENAI_API_KEY'),
    geminiApiKey: optional('GEMINI_API_KEY'),

    models: {
        anthropic: 'claude-haiku-4-5-20251001',
        openai: 'gpt-5.4-mini-2026-03-17',
        gemini: 'gemini-3.1-flash-lite-preview',
        sttRealtimeUrl: 'wss://api.openai.com/v1/realtime?intent=transcription',
        sttInputModel: 'gpt-4o-transcribe',
        // Note: STT uses the GA `session.update` shape (session.type='transcription',
        // session.audio.input.*). The older beta shape and the OpenAI-Beta:realtime=v1
        // header were retired in early 2026.
    },

    firestoreEmulator: optional('FIRESTORE_EMULATOR_HOST'),
    gcloudProject: optional('GCLOUD_PROJECT', 'panelchat-local'),

    defaults: {
        globalCooldownMs: 8_000,
        perCharacterCooldownMs: 25_000,
        targetPostsPerMinute: 2,
        // With 3 character slots, cap=2 means 2 bots deliberate + 1 fresh
        // bot answers = 3 posts total, each from a different model. Higher
        // caps make one bot speak twice in a row.
        deliberationCap: 2,
        transcriptWindowMs: 5 * 60 * 1000,
        recentChatPostsForContext: 30,
        triggerEvalIntervalMs: 1_500,
        // No posts when no transcript has arrived in this many ms.
        // 0 disables the gate (always tick on randomness etc.). Audience
        // questions still always go through.
        idleQuietMs: 30_000,
    },
};

export const isProd = process.env.NODE_ENV === 'production';
