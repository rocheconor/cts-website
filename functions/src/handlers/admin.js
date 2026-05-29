const admin = require('firebase-admin');
const { logger } = require('firebase-functions');

const ALLOWED_ORIGINS = new Set([
    'https://creativethinkingsystems.com',
    'https://www.creativethinkingsystems.com',
    'http://localhost:8765',
    'http://127.0.0.1:8765',
]);

function applyAdminCors(req, res) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return true;
    }
    return false;
}

function constantTimeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function bucket(rows, key) {
    const out = {};
    rows.forEach((r) => {
        const k = r[key] || 'unknown';
        out[k] = (out[k] || 0) + 1;
    });
    return out;
}

function tsMs(t) {
    if (!t) return 0;
    if (t.toMillis) return t.toMillis();
    if (t._seconds) return t._seconds * 1000;
    return new Date(t).getTime();
}

function within(rows, days) {
    const cutoff = Date.now() - days * 86400000;
    return rows.filter((r) => tsMs(r._ts) >= cutoff).length;
}

async function handleAdminStats(req, res, adminPassword) {
    if (applyAdminCors(req, res)) return;
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m || !constantTimeEq(m[1].trim(), (adminPassword || '').trim())) {
        res.status(401).json({ error: 'Unauthorised' });
        return;
    }

    try {
        const db = admin.firestore();

        const [subsSnap, submSnap] = await Promise.all([
            db.collection('newsletter_subscribers').get(),
            db.collection('aird_submissions').get(),
        ]);

        const subs = [];
        subsSnap.forEach((doc) => {
            const d = doc.data();
            subs.push({
                email: doc.id,
                source: d.source || 'unknown',
                confirmed: !!d.confirmed,
                _ts: d.timestamp,
                ts: tsMs(d.timestamp),
            });
        });
        subs.sort((a, b) => b.ts - a.ts);

        const subm = [];
        submSnap.forEach((doc) => {
            const d = doc.data();
            subm.push({
                id: doc.id,
                email: d.email || null,
                path: d.path || 'unknown',
                sector: d.sector || null,
                role: d.role || null,
                country: d.country || null,
                band: d.band || null,
                overallScore: typeof d.overallScore === 'number' ? d.overallScore : null,
                newsletter: !!d.newsletter,
                _ts: d.timestamp,
                ts: tsMs(d.timestamp),
            });
        });
        subm.sort((a, b) => b.ts - a.ts);

        const workbook = subm.filter((r) => r.path === 'workbook');
        const assessments = subm.filter(
            (r) => r.path === 'interactive-email' || r.path === 'interactive-download',
        );

        const avgScore = (rows) => {
            const vals = rows.map((r) => r.overallScore).filter((x) => typeof x === 'number');
            if (!vals.length) return null;
            return vals.reduce((a, b) => a + b, 0) / vals.length;
        };

        const stripTs = (r) => {
            const { _ts, ...rest } = r;
            return rest;
        };

        res.status(200).json({
            generatedAt: new Date().toISOString(),
            newsletter: {
                total: subs.length,
                last7Days: within(subs, 7),
                last30Days: within(subs, 30),
                bySource: bucket(subs, 'source'),
                recent: subs.slice(0, 30).map(stripTs),
            },
            workbook: {
                total: workbook.length,
                last7Days: within(workbook, 7),
                last30Days: within(workbook, 30),
                newsletterOptIns: workbook.filter((r) => r.newsletter).length,
                recent: workbook.slice(0, 30).map(stripTs),
            },
            assessments: {
                total: assessments.length,
                last7Days: within(assessments, 7),
                last30Days: within(assessments, 30),
                withEmail: assessments.filter((r) => r.path === 'interactive-email').length,
                anonymous: assessments.filter((r) => r.path === 'interactive-download').length,
                byBand: bucket(assessments, 'band'),
                bySector: bucket(assessments, 'sector'),
                averageScore: avgScore(assessments),
                recent: assessments.slice(0, 30).map(stripTs),
            },
        });
    } catch (err) {
        logger.error('Admin stats failed', err);
        res.status(500).json({ error: 'Could not fetch stats' });
    }
}

module.exports = { handleAdminStats };
