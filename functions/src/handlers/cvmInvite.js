const admin = require('firebase-admin');
const { logger } = require('firebase-functions');

const { applyCors } = require('../lib/cors');
const { isValidEmail, clean } = require('../lib/validation');
const { rateLimitOk, getClientIp } = require('../lib/rateLimit');
const { sendInviteRequestNotice } = require('../lib/email');

// Records a request for an invite to the Creative Value Monitor lookup preview
// (creativevaluemonitor.ai/lookup-preview/) and emails a notice to the CVM inbox.
// Requests are kept apart from newsletter_subscribers.
async function handleCvmInviteRequest(req, res, resendApiKey, lookupCodes) {
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

    let requests = 1;
    try {
        const db = admin.firestore();
        const ref = db.collection('cvm_invite_requests').doc(record.email);
        await ref.set({
            ...record,
            requests: admin.firestore.FieldValue.increment(1),
            lastRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
            ip,
        }, { merge: true });
        requests = (await ref.get()).get('requests') || 1;
    } catch (err) {
        logger.error('CVM invite request failed', err);
        res.status(500).json({ error: 'Could not record request' });
        return;
    }

    // The request is saved; a failed notice is logged but doesn't fail it.
    try {
        let codes = {};
        try { codes = JSON.parse(lookupCodes || '{}'); } catch (e) { logger.warn('CVM_LOOKUP_CODES is not valid JSON'); }
        await sendInviteRequestNotice({ apiKey: resendApiKey, ...record, requests, receivedAt: new Date(), code: codes[record.source] || null });
    } catch (err) {
        logger.error('CVM invite notice failed', err);
    }

    res.status(200).json({ ok: true });
}

module.exports = { handleCvmInviteRequest };
