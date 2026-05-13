// Simple per-IP rate limit backed by Firestore.
// Sliding window: max N requests per windowSeconds.

const admin = require('firebase-admin');

async function rateLimitOk(ip, action, max = 5, windowSeconds = 60) {
    if (!ip) return true; // unknown ip: skip
    const db = admin.firestore();
    const docId = `${action}__${ip.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    const ref = db.collection('rate_limits').doc(docId);

    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const hits = (snap.exists ? (snap.data().hits || []) : []).filter((t) => t > windowStart);
        if (hits.length >= max) return false;
        hits.push(now);
        tx.set(ref, { hits, updatedAt: now }, { merge: true });
        return true;
    });
}

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
        return xff.split(',')[0].trim();
    }
    return req.ip || req.connection?.remoteAddress || '';
}

module.exports = { rateLimitOk, getClientIp };
