#!/usr/bin/env bash
#
# Panelchat production deploy script.
#
# Assumes you have:
#   - gcloud auth configured against the target project
#   - firebase CLI authenticated for the same project
#   - All five production secrets ready (see SECRETS_FILE)
#
# Run from anywhere. Script cd's to the right dirs.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-cts-development-485012}"
REGION="${REGION:-europe-west1}"
SERVICE_NAME="${SERVICE_NAME:-panelchat-server}"
SECRETS_FILE="${SECRETS_FILE:-./deploy/secrets.prod.env}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ ! -f "${SECRETS_FILE}" ]]; then
    echo "[fail] missing ${SECRETS_FILE}" >&2
    echo "       see deploy/secrets.prod.env.example for the template." >&2
    exit 1
fi

set -a
# shellcheck disable=SC1090
source "${SECRETS_FILE}"
set +a

required=( ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY ADMIN_PASSWORD SESSION_COOKIE_SECRET )
for var in "${required[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        echo "[fail] required secret ${var} is empty in ${SECRETS_FILE}" >&2
        exit 1
    fi
done

echo "[deploy] project=${PROJECT_ID}  region=${REGION}  service=${SERVICE_NAME}"
echo "[deploy] uploading secrets to Secret Manager (creating new versions where needed)…"
upload_secret() {
    local name="$1"; local value="$2"
    if gcloud --project="${PROJECT_ID}" secrets describe "${name}" >/dev/null 2>&1; then
        printf '%s' "${value}" | gcloud --project="${PROJECT_ID}" secrets versions add "${name}" --data-file=- >/dev/null
    else
        printf '%s' "${value}" | gcloud --project="${PROJECT_ID}" secrets create "${name}" --replication-policy=automatic --data-file=- >/dev/null
    fi
    echo "  ✓ ${name}"
}

upload_secret PANELCHAT_ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY}"
upload_secret PANELCHAT_OPENAI_API_KEY "${OPENAI_API_KEY}"
upload_secret PANELCHAT_GEMINI_API_KEY "${GEMINI_API_KEY}"
upload_secret PANELCHAT_ADMIN_PASSWORD "${ADMIN_PASSWORD}"
upload_secret PANELCHAT_SESSION_COOKIE_SECRET "${SESSION_COOKIE_SECRET}"

echo ""
echo "[deploy] gcloud run deploy — this builds the Dockerfile and rolls a new revision…"
gcloud --project="${PROJECT_ID}" run deploy "${SERVICE_NAME}" \
    --source . \
    --region "${REGION}" \
    --allow-unauthenticated \
    --min-instances=0 \
    --max-instances=4 \
    --cpu=1 \
    --memory=512Mi \
    --port=8080 \
    --timeout=3600 \
    --set-env-vars="NODE_ENV=production,GCLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},SESSION_ID=panelchat-default,PUBLIC_BASE_URL=https://creativethinkingsystems.com" \
    --set-secrets="ANTHROPIC_API_KEY=PANELCHAT_ANTHROPIC_API_KEY:latest,OPENAI_API_KEY=PANELCHAT_OPENAI_API_KEY:latest,GEMINI_API_KEY=PANELCHAT_GEMINI_API_KEY:latest,ADMIN_PASSWORD=PANELCHAT_ADMIN_PASSWORD:latest,SESSION_COOKIE_SECRET=PANELCHAT_SESSION_COOKIE_SECRET:latest"

SERVICE_URL=$(gcloud --project="${PROJECT_ID}" run services describe "${SERVICE_NAME}" --region "${REGION}" --format="value(status.url)")
echo ""
echo "[deploy] Cloud Run service URL: ${SERVICE_URL}"
echo "[deploy] sanity probe:"
curl -fsS "${SERVICE_URL}/panelchat-api/health" || { echo "[fail] health check failed" >&2; exit 1; }
echo ""

echo ""
echo "[deploy] next steps:"
echo "         1) Patch root firebase.json to rewrite /panelchat-api/** to the panelchat-server Cloud Run service."
echo "         2) firebase hosting:channel:deploy panelchat-preview --project=${PROJECT_ID} --expires=2d"
echo "         3) Smoke-test the preview URL, then promote to live."
echo ""
echo "[deploy] done."
