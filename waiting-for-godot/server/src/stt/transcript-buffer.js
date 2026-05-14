// Rolling transcript buffer. Stores completed transcript segments with
// timestamps, exposes a text view of the last N ms (default from config).
// If sessionId is provided, completed segments are also persisted under
// wfg_sessions/{sessionId}/transcript.

import { config } from '../config.js';
import { paths, FieldValue } from '../lib/firestore.js';

export class TranscriptBuffer {
    constructor({ windowMs = config.defaults.transcriptWindowMs, persist = true, sessionId = null } = {}) {
        this.windowMs = windowMs;
        this.persist = persist;
        this.sessionId = sessionId;
        this.segments = []; // [{ at: number(ms), text: string }]
    }

    appendCompleted(text) {
        const t = (text || '').trim();
        if (!t) return;
        const at = Date.now();
        this.segments.push({ at, text: t });
        this.#trim(at);
        if (this.persist && this.sessionId) {
            paths
                .transcript(this.sessionId)
                .add({ text: t, createdAtMs: at, createdAt: FieldValue.serverTimestamp() })
                .catch(() => {});
        }
    }

    windowText() {
        this.#trim(Date.now());
        return this.segments.map((s) => s.text).join(' ');
    }

    sinceText(sinceMs) {
        return this.segments
            .filter((s) => s.at >= sinceMs)
            .map((s) => s.text)
            .join(' ');
    }

    setWindowMs(ms) {
        this.windowMs = Math.max(60_000, Math.floor(ms));
    }

    clear() {
        this.segments = [];
    }

    #trim(now) {
        const cutoff = now - this.windowMs;
        while (this.segments.length && this.segments[0].at < cutoff) {
            this.segments.shift();
        }
    }
}
