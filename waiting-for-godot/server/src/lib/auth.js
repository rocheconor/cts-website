// Signed-cookie admin sessions. Single shared password.
// Cookie value: base64(payload).hex(hmac). Payload = { exp }.

import crypto from 'node:crypto';
import * as cookie from 'cookie';
import { config } from '../config.js';

// Firebase Hosting only forwards cookies named __session to the Cloud
// Run backend; all others are stripped before they reach us. Using the
// __session name is required for auth to survive the Hosting hop.
// Trade-off: if the operator is also signed in to panelchat-server admin
// (which also uses __session), the most recent login wins — both
// products can't be active in the same browser at the same time.
const COOKIE_NAME = '__session';
const MAX_AGE_SECONDS = 12 * 60 * 60;

const sign = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('hex');
    return `${body}.${mac}`;
};

const verify = (raw) => {
    if (!raw || typeof raw !== 'string' || !raw.includes('.')) return null;
    const [body, mac] = raw.split('.');
    const expected = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('hex');
    if (mac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
};

export const issueAdminCookie = (res) => {
    const payload = { exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS };
    res.setHeader(
        'Set-Cookie',
        cookie.serialize(COOKIE_NAME, sign(payload), {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: MAX_AGE_SECONDS,
            secure: process.env.NODE_ENV === 'production',
        }),
    );
};

export const clearAdminCookie = (res) => {
    res.setHeader(
        'Set-Cookie',
        cookie.serialize(COOKIE_NAME, '', {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 0,
        }),
    );
};

export const isAuthenticated = (req) => {
    const header = req.headers.cookie;
    if (!header) return false;
    const parsed = cookie.parse(header);
    return Boolean(verify(parsed[COOKIE_NAME]));
};

export const requireAdmin = (req, res, next) => {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'unauthorized' });
};

export const checkPassword = (provided) => {
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(config.adminPassword);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};
