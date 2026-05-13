const admin = require('firebase-admin');
const { logger } = require('firebase-functions');

const { applyCors } = require('../lib/cors');
const { isValidEmail, clean } = require('../lib/validation');
const { rateLimitOk, getClientIp } = require('../lib/rateLimit');

async function handleNewsletterSubscribe(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const ip = getClientIp(req);
    if (!(await rateLimitOk(ip, 'newsletter', 5, 60))) {
        res.status(429).json({ error: 'Too many requests' });
        return;
    }

    const { email, source, hp } = req.body || {};

    if (hp) {
        res.status(200).json({ ok: true });
        return;
    }

    if (!isValidEmail(email)) {
        res.status(400).json({ error: 'Invalid email address' });
        return;
    }

    try {
        const db = admin.firestore();
        await db.collection('newsletter_subscribers').doc(email.toLowerCase()).set({
            email: email.toLowerCase(),
            source: clean(source, 40) || 'unknown',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            confirmed: true,
            ip,
        }, { merge: true });

        res.status(200).json({ ok: true });
    } catch (err) {
        logger.error('Newsletter subscribe failed', err);
        res.status(500).json({ error: 'Could not subscribe' });
    }
}

module.exports = { handleNewsletterSubscribe };
