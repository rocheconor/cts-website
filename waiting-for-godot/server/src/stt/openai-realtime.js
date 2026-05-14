// OpenAI Realtime transcription session.
// Server-side WebSocket client that proxies operator audio into OpenAI's
// realtime transcription endpoint and emits transcript text to a callback.
//
// Protocol notes (per https://developers.openai.com/api/docs/guides/realtime-transcription):
//   - Connect with WebSocket to wss://api.openai.com/v1/realtime?intent=transcription
//   - Authorization: Bearer <key> ; OpenAI-Beta: realtime=v1
//   - Configure with `transcription_session.update`
//   - Audio: 24 kHz mono PCM16, base64-encoded via input_audio_buffer.append
//   - Receive `conversation.item.input_audio_transcription.delta` and `.completed`
//
// If the server-side WebSocket auth flow shifts to ephemeral client tokens
// at build time, swap getRealtimeUrl() / headers — protocol is otherwise the
// same.

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
        this.ws = new WebSocket(REALTIME_URL, {
            headers: {
                Authorization: `Bearer ${config.openaiApiKey}`,
                'OpenAI-Beta': 'realtime=v1',
            },
        });

        await new Promise((resolve, reject) => {
            this.ws.once('open', resolve);
            this.ws.once('error', reject);
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
            type: 'transcription_session.update',
            session: {
                input_audio_format: 'pcm16',
                input_audio_transcription: { model: STT_MODEL, language: 'en' },
                turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 600 },
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
            case 'transcription_session.updated':
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
