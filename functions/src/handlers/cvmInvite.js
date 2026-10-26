const admin = require('firebase-admin');
const { logger } = require('firebase-functions');

const { applyCors } = require('../lib/cors');
const { isValidEmail, clean } = require('../lib/validation');
const { rateLimitOk, getClientIp } = require('../lib/rateLimit');
const { sendInviteRequestNotice } = require('../lib/email');

// Records a request for an invite to the Creative Value Monitor lookup preview
// (creativevaluemonitor.ai/lookup-preview/) and emails a notice to the CVM inbox.
// Requests are kept apart from newsletter_subscribers.
async function handleCvmInviteRequest(req, res, resendApiKey) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const ip = getClientIp(req);
    if (!(await rateLimitOk(ip, 'cvm-invite', 5, 60))) {
        res.status(429).json({ error: 'Too many requests' });
        return;
    }

    const { email, organisation, source, hp } = req.body || {};

    if (hp) {
        res.status(200).json({ ok: true });
        return;
    }

    if (!isValidEmail(email)) {
        res.status(400).json({ error: 'Invalid email address' });
        return;
    }

    const record = {
        email: email.toLowerCase(),
        organisation: clean(organisation, 120),
        source: clean(source, 40) || 'unknown',
    };

    try {
        const db = admin.firestore();
        await db.collection('cvm_invite_requests').doc(record.email).set({
            ...record,
            requests: admin.firestore.FieldValue.increment(1),
            lastRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
            ip,
        }, { merge: true });
    } catch (err) {
        logger.error('CVM invite request failed', err);
        res.status(500).json({ error: 'Could not record request' });
        return;
    }

    // The request is saved; a failed notice is logged but doesn't fail it.
    try {
        await sendInviteRequestNotice({ apiKey: resendApiKey, ...record });
    } catch (err) {
        logger.error('CVM invite notice failed', err);
    }

    res.status(200).json({ ok: true });
}

module.exports = { handleCvmInviteRequest };
