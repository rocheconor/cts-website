// Firebase Admin SDK init. Connects to the Firestore emulator when
// FIRESTORE_EMULATOR_HOST is set; otherwise expects ADC for real Firestore.
//
// All paths are parameterized by sessionId. The orchestrator owns which
// session is currently loaded; the single `wfg_state/active` doc names which
// session the public /wfg URL renders.

import admin from 'firebase-admin';
import { config } from '../config.js';

if (!admin.apps.length) {
    admin.initializeApp({ projectId: config.gcloudProject });
}

export const db = admin.firestore();

export const paths = {
    activePointer: () => db.collection('wfg_state').doc('active'),
    sessions: () => db.collection('wfg_sessions'),
    session: (sessionId) => db.collection('wfg_sessions').doc(sessionId),
    posts: (sessionId) => db.collection('wfg_sessions').doc(sessionId).collection('posts'),
    post: (sessionId, postId) =>
        db.collection('wfg_sessions').doc(sessionId).collection('posts').doc(postId),
    transcript: (sessionId) =>
        db.collection('wfg_sessions').doc(sessionId).collection('transcript'),
    log: (sessionId) => db.collection('wfg_sessions').doc(sessionId).collection('log'),
    profiles: (sessionId) =>
        db.collection('wfg_sessions').doc(sessionId).collection('profiles'),
    profile: (sessionId, charId) =>
        db.collection('wfg_sessions').doc(sessionId).collection('profiles').doc(charId),
    podcasts: (sessionId) =>
        db.collection('wfg_sessions').doc(sessionId).collection('podcasts'),
    podcast: (sessionId, id) =>
        db.collection('wfg_sessions').doc(sessionId).collection('podcasts').doc(id),
};

export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
