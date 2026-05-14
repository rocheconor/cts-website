// Append-only session log. Writes to the currently-loaded session's
// log subcollection and to stdout.
//
// If no session is loaded yet (very early boot), Firestore write is skipped
// and the entry is logged to stdout only — so logging itself never blocks
// boot.

import { paths, FieldValue } from './firestore.js';
import { getCurrentSessionId } from './current-session.js';

const LEVELS = new Set(['info', 'warn', 'error', 'critical']);

export const logEvent = async ({ level = 'info', source, event, data }) => {
    const safeLevel = LEVELS.has(level) ? level : 'info';
    const entry = {
        level: safeLevel,
        source: source || 'server',
        event: event || 'log',
        data: data || null,
        createdAtMs: Date.now(),
    };
    const tag = safeLevel.toUpperCase().padEnd(8);
    console.log(`[${tag}] ${entry.source} :: ${entry.event}`, data ?? '');
    const sid = getCurrentSessionId();
    if (!sid) return;
    try {
        await paths.log(sid).add({ ...entry, createdAt: FieldValue.serverTimestamp() });
    } catch (err) {
        console.error('[log] failed to persist log entry', err.message);
    }
};

export const logCritical = (source, event, data) =>
    logEvent({ level: 'critical', source, event, data });

export const logError = (source, event, data) => logEvent({ level: 'error', source, event, data });
export const logWarn = (source, event, data) => logEvent({ level: 'warn', source, event, data });
export const logInfo = (source, event, data) => logEvent({ level: 'info', source, event, data });
