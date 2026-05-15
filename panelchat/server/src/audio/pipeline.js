// Audio pipeline. Owns the active STT session and feeds it from either:
//   - the operator's browser WebSocket (live), or
//   - a WAV file in dev-audio/ (staging / dev).
// Routes completed transcript segments to the orchestrator.

import fs from 'node:fs';
import path from 'node:path';
import wavefilePkg from 'wavefile';
const { WaveFile } = wavefilePkg;
import { SttSession } from '../stt/openai-realtime.js';
import { logError, logInfo, logWarn } from '../lib/log.js';

const FRAME_MS = 100;
const SAMPLE_RATE = 24_000;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

export class AudioPipeline {
    constructor({ orchestrator, devAudioDir }) {
        this.orchestrator = orchestrator;
        this.devAudioDir = devAudioDir;
        this.stt = null;
        this.mode = null; // 'live' | 'file' | null
        this.liveSockets = new Set();
        this.fileTimer = null;
    }

    status() {
        return { mode: this.mode, liveListeners: this.liveSockets.size };
    }

    async #ensureStt() {
        if (this.stt && !this.stt.closed) return this.stt;
        this.stt = new SttSession();
        this.stt.on('delta', (text) => this.orchestrator.onTranscriptDelta(text));
        this.stt.on('completed', (text) => this.orchestrator.onTranscriptCompleted(text));
        this.stt.on('close', () => {
            if (this.stt && this.stt.closed) this.stt = null;
        });
        await this.stt.open();
        return this.stt;
    }

    async startLive() {
        if (this.mode === 'live') return;
        await this.stop();
        await this.#ensureStt();
        this.mode = 'live';
        logInfo('audio', 'live_mode_started');
    }

    attachOperatorSocket(ws) {
        this.liveSockets.add(ws);
        ws.on('message', (raw) => this.#handleLiveFrame(raw));
        ws.on('close', () => this.liveSockets.delete(ws));
        ws.on('error', () => this.liveSockets.delete(ws));
    }

    #handleLiveFrame(raw) {
        if (this.mode !== 'live' || !this.stt?.ready) return;
        let msg;
        try {
            msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (msg?.type === 'audio' && typeof msg.data === 'string') {
            this.stt.appendAudio(msg.data);
        }
    }

    async startFile(filename) {
        const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safe || safe !== filename) throw new Error('Bad filename');
        const filePath = path.join(this.devAudioDir, safe);
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${safe}`);

        await this.stop();
        await this.#ensureStt();
        this.mode = 'file';
        logInfo('audio', 'file_mode_started', { filename: safe });

        const buf = fs.readFileSync(filePath);
        const wav = new WaveFile(buf);
        wav.toBitDepth('16');
        wav.toSampleRate(SAMPLE_RATE);
        const samples = wav.getSamples(false, Int16Array); // interleaved or mono Int16Array
        const mono = Array.isArray(samples) ? mixToMono(samples) : samples;

        let offset = 0;
        const totalSamples = mono.length;

        this.fileTimer = setInterval(() => {
            if (offset >= totalSamples) {
                clearInterval(this.fileTimer);
                this.fileTimer = null;
                logInfo('audio', 'file_mode_complete');
                return;
            }
            const end = Math.min(offset + SAMPLES_PER_FRAME, totalSamples);
            const slice = mono.subarray(offset, end);
            const b64 = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('base64');
            this.stt?.appendAudio(b64);
            offset = end;
        }, FRAME_MS);
    }

    async stop() {
        if (this.fileTimer) {
            clearInterval(this.fileTimer);
            this.fileTimer = null;
        }
        for (const ws of this.liveSockets) {
            try {
                ws.close();
            } catch {}
        }
        this.liveSockets.clear();
        if (this.stt) {
            try {
                this.stt.close();
            } catch {}
            this.stt = null;
        }
        this.mode = null;
        logInfo('audio', 'stopped');
    }

    listDevAudio() {
        try {
            return fs
                .readdirSync(this.devAudioDir)
                .filter((f) => /\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(f))
                .map((f) => ({ filename: f, supported: /\.wav$/i.test(f) }));
        } catch (err) {
            logWarn('audio', 'list_dev_audio_failed', { message: err.message });
            return [];
        }
    }
}

const mixToMono = (channels) => {
    if (!Array.isArray(channels) || !channels.length) return new Int16Array(0);
    if (channels.length === 1) return channels[0];
    const len = channels[0].length;
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
        let sum = 0;
        for (const ch of channels) sum += ch[i] || 0;
        out[i] = Math.max(-32768, Math.min(32767, Math.round(sum / channels.length)));
    }
    return out;
};
