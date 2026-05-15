// Smoke test: connect to OpenAI Realtime transcription (GA shape), push 1
// second of silence, wait for session.updated, then close. Confirms auth +
// protocol without needing real audio.

import WebSocket from 'ws';
import { config } from '../config.js';

const URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

const main = async () => {
    if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY not set in .env.local');
    const t0 = Date.now();
    const ws = new WebSocket(URL, {
        headers: {
            Authorization: `Bearer ${config.openaiApiKey}`,
        },
    });

    let sessionConfigured = false;

    const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Timed out waiting for session.updated'));
        }, 10_000);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    type: 'transcription',
                    audio: {
                        input: {
                            format: { type: 'audio/pcm', rate: 24000 },
                            transcription: { model: config.models.sttInputModel, language: 'en' },
                            turn_detection: { type: 'server_vad' },
                        },
                    },
                },
            }));
        });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === 'error') {
                clearTimeout(timeout);
                ws.close();
                return reject(new Error(JSON.stringify(msg.error || msg)));
            }
            if (msg.type === 'session.updated' || msg.type === 'session.created') {
                if (sessionConfigured) return;
                sessionConfigured = true;
                // Push 1 second of silence (24000 samples * 2 bytes = 48000 bytes)
                const silence = Buffer.alloc(48000);
                ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: silence.toString('base64') }));
                setTimeout(() => {
                    clearTimeout(timeout);
                    ws.close();
                    resolve();
                }, 1500);
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    await done;
    console.log(`[ok] openai-realtime stt session opened + configured in ${Date.now() - t0}ms`);
};
main().catch((err) => { console.error('[fail]', err.message); process.exit(1); });
