// Centralised env config. Every other module reads from here, not process.env.

const required = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env: ${name}`);
    return v;
};

const optional = (name, fallback) => process.env[name] ?? fallback;

export const config = {
    // Cloud Run sets PORT=8080 by default; honour it. Local dev defaults to 8787.
    port: Number(optional('PORT', '8787')),
    sessionId: optional('SESSION_ID', 'change-makers-2026'),
    publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:8787'),

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
    },

    firestoreEmulator: optional('FIRESTORE_EMULATOR_HOST'),
    gcloudProject: optional('GCLOUD_PROJECT', 'wfg-local'),

    defaults: {
        globalCooldownMs: 8_000,
        perCharacterCooldownMs: 25_000,
        targetPostsPerMinute: 2,
        godotDeliberationCap: 3,
        transcriptWindowMs: 5 * 60 * 1000,
        recentChatPostsForContext: 30,
        triggerEvalIntervalMs: 1_500,
    },
};

export const isProd = process.env.NODE_ENV === 'production';
