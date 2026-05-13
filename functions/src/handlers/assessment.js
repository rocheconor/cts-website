const crypto = require('crypto');
const admin = require('firebase-admin');
const { logger } = require('firebase-functions');

const { applyCors } = require('../lib/cors');
const { isValidEmail, clean, isScoreMap, isValidSector } = require('../lib/validation');
const { rateLimitOk, getClientIp } = require('../lib/rateLimit');
const { sendReportEmail } = require('../lib/email');
const { renderHtmlToPdf } = require('../lib/pdf');
const { buildReportHtml, reportPageHeaderFooter, bandFor } = require('../lib/report');

async function handleSubmitAssessment(req, res, resendApiKey) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const ip = getClientIp(req);
    if (!(await rateLimitOk(ip, 'assessment', 5, 60))) {
        res.status(429).json({ error: 'Too many requests' });
        return;
    }

    const body = req.body || {};
    if (body.hp) {
        res.status(200).json({ ok: true });
        return;
    }

    // Email is optional: the "Download as PDF" path on the results screen
    // generates the report without asking for an email. The "Email me" path
    // provides it. Either way scores still go to Firestore for the benchmark.
    const hasEmail = body.email != null && body.email !== '';
    if (hasEmail && !isValidEmail(body.email)) {
        res.status(400).json({ error: 'Invalid email address' });
        return;
    }
    if (!isScoreMap(body.scores)) {
        res.status(400).json({ error: 'Invalid scores' });
        return;
    }
    if (body.sector && !isValidSector(body.sector)) {
        res.status(400).json({ error: 'Invalid sector' });
        return;
    }

    const email = hasEmail ? body.email.toLowerCase() : null;
    const organisation = clean(body.organisation, 200);
    const role = clean(body.role, 120);
    const country = clean(body.country, 80);
    const sector = body.sector || 'other';

    // Compute overall score and band server-side so we don't trust the client.
    const values = ['q1','q2','q3','q4','q5','q6','q7','q8'].map((k) => body.scores[k]);
    const sum = values.reduce((a, b) => a + b, 0);
    const overallScore = sum / values.length;
    const band = bandFor(overallScore);

    try {
        // Persist submission first (we want a record even if email fails).
        const db = admin.firestore();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const submissionRef = await db.collection('aird_submissions').add({
            email: email || null,
            path: hasEmail ? 'interactive-email' : 'interactive-download',
            newsletter: hasEmail && !!body.newsletter,
            sector,
            organisation: organisation || null,
            role: role || null,
            country: country || null,
            scores: body.scores,
            overallScore,
            band,
            ip,
            userAgent: req.headers['user-agent'] || '',
            timestamp: now,
        });

        if (hasEmail && body.newsletter) {
            await db.collection('newsletter_subscribers').doc(email).set({
                email,
                source: 'aird-assessment',
                timestamp: now,
                confirmed: true,
            }, { merge: true });
        }

        // Generate the PDF.
        const html = buildReportHtml({
            organisation,
            role,
            country,
            sector,
            scores: body.scores,
            overallScore,
            band,
        });
        const { header, footer } = reportPageHeaderFooter(organisation);
        const pdfBytes = await renderHtmlToPdf(html, {
            headerTemplate: header,
            footerTemplate: footer,
        });

        // Save to Storage so we can return a signed download URL.
        const bucket = admin.storage().bucket();
        const token = crypto.randomBytes(16).toString('hex');
        const filename = `aird-reports/${submissionRef.id}-${token}.pdf`;
        const file = bucket.file(filename);
        await file.save(pdfBytes, {
            metadata: {
                contentType: 'application/pdf',
                metadata: { firebaseStorageDownloadTokens: token },
            },
        });

        const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filename)}?alt=media&token=${token}`;

        // Send the email only if one was provided.
        if (hasEmail) {
            await sendReportEmail({
                apiKey: resendApiKey,
                to: email,
                downloadUrl,
                attachmentBytes: pdfBytes,
            });
        }

        res.status(200).json({ ok: true, downloadUrl, mode: hasEmail ? 'email' : 'download' });
    } catch (err) {
        logger.error('Assessment submission failed', err);
        res.status(500).json({ error: 'Could not process submission' });
    }
}

module.exports = { handleSubmitAssessment };
