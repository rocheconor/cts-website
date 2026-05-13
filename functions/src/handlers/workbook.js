const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const { logger } = require('firebase-functions');

const { applyCors } = require('../lib/cors');
const { isValidEmail } = require('../lib/validation');
const { rateLimitOk, getClientIp } = require('../lib/rateLimit');
const { sendWorkbookEmail } = require('../lib/email');

const WORKBOOK_URL = 'https://creativethinkingsystems.com/aird/AI-readiness-workbook.pdf';
const WORKBOOK_PATH = path.join(__dirname, '..', '..', 'assets', 'AI-readiness-workbook.pdf');

function getWorkbookBytes() {
    if (fs.existsSync(WORKBOOK_PATH)) {
        return fs.readFileSync(WORKBOOK_PATH);
    }
    return null; // fall back to link-only delivery
}

async function handleWorkbookRequest(req, res, resendApiKey) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const ip = getClientIp(req);
    if (!(await rateLimitOk(ip, 'workbook', 5, 60))) {
        res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
        return;
    }

    const { email, newsletter, hp } = req.body || {};

    if (hp) {
        // Honeypot tripped: silently accept without doing anything.
        res.status(200).json({ ok: true });
        return;
    }

    if (!isValidEmail(email)) {
        res.status(400).json({ error: 'Invalid email address' });
        return;
    }

    const db = admin.firestore();
    const now = admin.firestore.FieldValue.serverTimestamp();

    try {
        await db.collection('aird_submissions').add({
            email: email.toLowerCase(),
            path: 'workbook',
            newsletter: !!newsletter,
            ip,
            userAgent: req.headers['user-agent'] || '',
            timestamp: now,
        });

        if (newsletter) {
            await db.collection('newsletter_subscribers').doc(email.toLowerCase()).set({
                email: email.toLowerCase(),
                source: 'aird-workbook',
                timestamp: now,
                confirmed: true,
            }, { merge: true });
        }

        const attachment = getWorkbookBytes();
        if (!attachment) {
            logger.warn('Workbook PDF asset not found, sending link only.');
        }

        await sendWorkbookEmail({
            apiKey: resendApiKey,
            to: email,
            downloadUrl: WORKBOOK_URL,
            attachmentBytes: attachment,
        });

        res.status(200).json({ ok: true, downloadUrl: WORKBOOK_URL });
    } catch (err) {
        logger.error('Workbook request failed', err);
        res.status(500).json({ error: 'Could not process request' });
    }
}

module.exports = { handleWorkbookRequest };
