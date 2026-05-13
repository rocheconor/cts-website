const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(s) {
    return typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);
}

function clean(s, max = 200) {
    if (typeof s !== 'string') return '';
    return s.trim().slice(0, max);
}

function isScoreMap(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const keys = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'];
    return keys.every((k) => {
        const v = obj[k];
        return Number.isInteger(v) && v >= 1 && v <= 5;
    });
}

const ALLOWED_SECTORS = new Set([
    'theatre', 'museum', 'festival', 'music',
    'screen', 'publishing', 'agency', 'funder', 'other',
]);

function isValidSector(s) {
    return typeof s === 'string' && ALLOWED_SECTORS.has(s);
}

module.exports = { isValidEmail, clean, isScoreMap, isValidSector };
