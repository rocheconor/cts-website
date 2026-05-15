// Thin client for the NotebookLM Enterprise Podcast API
// (Discovery Engine v1). Long-running operations only.
//
// Docs: https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/podcast-api
//
// Auth: GCP Application Default Credentials. The Cloud Run service account
// needs roles/discoveryengine.podcastApiUser on the project, and the
// Discovery Engine API must be enabled.

import { GoogleAuth } from 'google-auth-library';
import { config } from '../config.js';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const API_HOST = 'https://discoveryengine.googleapis.com';

const auth = new GoogleAuth({ scopes: [SCOPE] });

const accessToken = async () => {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('podcast_auth_failed');
    return token;
};

const apiFetch = async (path, init = {}) => {
    const token = await accessToken();
    const url = path.startsWith('http') ? path : `${API_HOST}${path}`;
    const res = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {}),
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`podcast_api_${res.status}`);
        err.status = res.status;
        err.detail = text.slice(0, 4000);
        throw err;
    }
    return res;
};

// Kick off a podcast generation. Returns the operation name (LRO).
// `contexts` is the array of {text} or {inlineData} objects the API
// accepts; we only use text contexts. `length` must be 'SHORT' or 'STANDARD'.
export const createPodcast = async ({
    projectId,
    focus,
    length,
    title,
    description,
    contexts,
    languageCode,
}) => {
    if (!projectId) throw new Error('missing_project_id');
    if (!['SHORT', 'STANDARD'].includes(length)) throw new Error('invalid_length');
    if (!Array.isArray(contexts) || contexts.length === 0) throw new Error('empty_contexts');

    const body = {
        podcastConfig: {
            focus: focus || '',
            length,
            ...(languageCode ? { languageCode } : {}),
        },
        contexts,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
    };

    const path = `/v1/projects/${encodeURIComponent(projectId)}/locations/global/podcasts`;
    const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
    const json = await res.json();
    // The API responds with an operation envelope: { name, metadata, done? }.
    if (!json?.name) {
        const err = new Error('podcast_no_operation_name');
        err.detail = JSON.stringify(json).slice(0, 4000);
        throw err;
    }
    return json;
};

// Poll an LRO. Returns the operation as { name, done, error?, response? }.
export const getOperation = async (operationName) => {
    if (!operationName) throw new Error('missing_operation_name');
    const path = `/v1/${operationName}`;
    const res = await apiFetch(path, { method: 'GET' });
    return res.json();
};

// Stream the MP3 for a completed operation. Returns the Response object;
// caller is responsible for piping res.body to its own response stream.
export const downloadAudio = async (operationName) => {
    if (!operationName) throw new Error('missing_operation_name');
    const path = `/v1/${operationName}:download?alt=media`;
    return apiFetch(path, { method: 'GET' });
};

// Build a contexts array from plain text inputs. Splits into separate
// entries so the API can keep them visually distinct in its prompt.
export const buildTextContexts = ({ transcript, chat }) => {
    const out = [];
    const tx = (transcript || '').trim();
    const ch = (chat || '').trim();
    if (tx) out.push({ text: `Panel transcript:\n${tx}` });
    if (ch) out.push({ text: `AI commentary on the panel:\n${ch}` });
    return out;
};

// Resolve the GCP project ID for the API call. Cloud Run sets
// GOOGLE_CLOUD_PROJECT; locally we read from the same config.gcloudProject.
export const resolveProjectId = () => config.gcloudProject;
