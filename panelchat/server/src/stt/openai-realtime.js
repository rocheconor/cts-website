// OpenAI Realtime transcription session.
// Server-side WebSocket client that proxies operator audio into OpenAI's
// realtime transcription endpoint and emits transcript text to a callback.
//
// Protocol notes (GA shape; the older beta shape with `OpenAI-Beta: realtime=v1`
// + `transcription_session.update` was disabled in early 2026):
//   - Connect with WebSocket to wss://api.openai.com/v1/realtime?intent=transcription
//   - Authorization: Bearer <api-key> (no OpenAI-Beta header)
//   - Configure with a `session.update` whose session.type is "transcription"
//   - Audio: PCM16, 24 kHz mono, base64-encoded via input_audio_buffer.append
//   - Receive `conversation.item.input_audio_transcription.delta` and `.completed`

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logError, logWarn, logInfo } from '../lib/log.js';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const STT_MODEL = config.models.sttInputModel;

export class SttSession extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.ready = false;
        this.closed = false;
    }

    async open() {
        if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY not set');
        logInfo('stt', 'opening', { url: REALTIME_URL, model: STT_MODEL });
        this.ws = new WebSocket(REALTIME_URL, {
            headers: {
                Authorization: `Bearer ${config.openaiApiKey}`,
            },
            // Don't let the handshake hang forever — if OpenAI accepts TCP
            // but stalls the upgrade we want a clean error, not a stuck
            // request.
            handshakeTimeout: 10_000,
        });

        // Log close/error events that fire *during* the handshake too —
        // the once('error', reject) handler below only fires the first
        // error, after which the listener detaches. Keep these listeners
        // attached so a late close after a partial handshake still logs.
        this.ws.on('unexpected-response', (_req, res) => {
            logError('stt', 'unexpected_response', { statusCode: res.statusCode, headers: res.headers });
        });

        await new Promise((resolve, reject) => {
            const onOpen = () => { cleanup(); resolve(); };
            const onError = (err) => { cleanup(); reject(err); };
            const onClose = (code, reason) => { cleanup(); reject(new Error(`closed during handshake: code=${code} reason=${reason?.toString()}`)); };
            const cleanup = () => {
                this.ws.removeListener('open', onOpen);
                this.ws.removeListener('error', onError);
                this.ws.removeListener('close', onClose);
            };
            this.ws.once('open', onOpen);
            this.ws.once('error', onError);
            this.ws.once('close', onClose);
        });

        this.ws.on('message', (raw) => this.#onMessage(raw));
        this.ws.on('close', (code, reason) => {
            this.closed = true;
            this.ready = false;
            logWarn('stt', 'ws_closed', { code, reason: reason?.toString() });
            this.emit('close', { code });
        });
        this.ws.on('error', (err) => {
            logError('stt', 'ws_error', { message: err.message });
            this.emit('socket_error', err);
        });

        this.#send({
            type: 'session.update',
            session: {
                type: 'transcription',
                audio: {
                    input: {
                        format: { type: 'audio/pcm', rate: 24000 },
                        transcription: { model: STT_MODEL, language: 'en' },
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 600,
                        },
                    },
                },
            },
        });

        this.ready = true;
        logInfo('stt', 'opened');
    }

    appendAudio(base64Pcm16) {
        if (!this.ready || this.closed) return;
        this.#send({ type: 'input_audio_buffer.append', audio: base64Pcm16 });
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.ready = false;
        try {
            this.ws?.close();
        } catch {}
    }

    #send(payload) {
        try {
            this.ws.send(JSON.stringify(payload));
        } catch (err) {
            logError('stt', 'send_failed', { message: err.message });
        }
    }

    #onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        switch (msg.type) {
            case 'conversation.item.input_audio_transcription.delta':
                if (msg.delta) this.emit('delta', msg.delta);
                break;
            case 'conversation.item.input_audio_transcription.completed':
                if (msg.transcript) this.emit('completed', msg.transcript);
                break;
            case 'session.updated':
            case 'session.created':
                // configuration acks
                break;
            case 'error':
                logError('stt', 'realtime_error', msg.error || msg);
                this.emit('protocol_error', msg.error || msg);
                break;
            default:
                // many other realtime events; ignore.
                break;
        }
    }
}
