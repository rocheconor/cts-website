// Allow requests from the live site and from localhost (dev).
const ALLOWED_ORIGINS = new Set([
    'https://creativethinkingsystems.com',
    'https://www.creativethinkingsystems.com',
    'http://localhost:8765',
    'http://127.0.0.1:8765',
]);

function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return true;
    }
    return false;
}

module.exports = { applyCors };
