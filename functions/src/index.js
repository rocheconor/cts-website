// Entry point for Creative Thinking Systems Cloud Functions.
//
// Three HTTP endpoints, all 2nd-gen, served from europe-west1:
//   POST /api/workbook-request    -> sends the static workbook PDF by email
//   POST /api/newsletter-subscribe -> records a newsletter opt-in
//   POST /api/submit-assessment   -> persists, generates the personalised
//                                    report PDF, and emails it
//
// All three are exposed under /api/** via hosting rewrites (see firebase.json).

const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');

if (!admin.apps.length) admin.initializeApp();

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const ADMIN_PASSWORD = defineSecret('ADMIN_PASSWORD');
// Lookup Preview invite codes by page, as JSON: {"cvm-lookup": "…", "cvm-lookup-eit": "…"}.
const CVM_LOOKUP_CODES = defineSecret('CVM_LOOKUP_CODES');

const { handleWorkbookRequest } = require('./handlers/workbook');
const { handleNewsletterSubscribe } = require('./handlers/newsletter');
const { handleSubmitAssessment } = require('./handlers/assessment');
const { handleAdminStats } = require('./handlers/admin');
const { handleCvmInviteRequest } = require('./handlers/cvmInvite');

// Served from creativevaluemonitor.ai via a hosting rewrite in that repo
// (POST /api/lookup-invite-request), so CORS doesn't apply.
exports.cvmInviteRequest = onRequest(
    {
        cors: false,
        memory: '256MiB',
        timeoutSeconds: 15,
        secrets: [RESEND_API_KEY, CVM_LOOKUP_CODES],
    },
    (req, res) => handleCvmInviteRequest(req, res, RESEND_API_KEY.value(), CVM_LOOKUP_CODES.value()),
);

exports.workbookRequest = onRequest(
    {
        cors: false,
        memory: '512MiB',
        timeoutSeconds: 30,
        secrets: [RESEND_API_KEY],
    },
    (req, res) => handleWorkbookRequest(req, res, RESEND_API_KEY.value()),
);

exports.newsletterSubscribe = onRequest(
    {
        cors: false,
        memory: '256MiB',
        timeoutSeconds: 15,
    },
    (req, res) => handleNewsletterSubscribe(req, res),
);

exports.submitAssessment = onRequest(
    {
        cors: false,
        memory: '1GiB',
        timeoutSeconds: 60,
        secrets: [RESEND_API_KEY],
    },
    (req, res) => handleSubmitAssessment(req, res, RESEND_API_KEY.value()),
);

exports.adminStats = onRequest(
    {
        cors: false,
        memory: '256MiB',
        timeoutSeconds: 30,
        secrets: [ADMIN_PASSWORD],
    },
    (req, res) => handleAdminStats(req, res, ADMIN_PASSWORD.value()),
);
