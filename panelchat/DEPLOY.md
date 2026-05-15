# Deploying Panelchat

Deploys the `panelchat-server` Cloud Run service in `europe-west1` and wires it to `creativethinkingsystems.com` via Firebase Hosting rewrites. About 15 minutes end to end.

## What this deploys

- A new Cloud Run service `panelchat-server` in `europe-west1` running `panelchat/server/`.
- Five secrets in GCP Secret Manager (`PANELCHAT_ANTHROPIC_API_KEY`, `PANELCHAT_OPENAI_API_KEY`, `PANELCHAT_GEMINI_API_KEY`, `PANELCHAT_ADMIN_PASSWORD`, `PANELCHAT_SESSION_COOKIE_SECRET`).
- Hosting rewrites added to the root `firebase.json`:
  - `/panelchat-api/**` → the `panelchat-server` Cloud Run service
  - `/panelchat/sessions/<id>/` → the visitor template (so archive URLs render)
  - `/panelchat/admin/**` → static files in `panelchat/web/admin/`
  - `/panelchat/**` → static files in `panelchat/web/visitor/`

Existing hosting (newsletter, AI Readiness, Waiting for Godot, etc.) is untouched.

## Prereqs

- `gcloud` CLI authenticated against `cts-development-485012`.
- `firebase` CLI authenticated for the same project.
- All five production secrets ready (see step 1).

## Step 1 — Production secrets

```bash
cd panelchat
cp deploy/secrets.prod.env.example deploy/secrets.prod.env
$EDITOR deploy/secrets.prod.env
```

| Secret | How to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys → **create new** |
| `OPENAI_API_KEY` | platform.openai.com → API keys → **create new** |
| `GEMINI_API_KEY` | aistudio.google.com → API keys → **create new** |
| `ADMIN_PASSWORD` | pick a real one (12+ chars). Operator console password. |
| `SESSION_COOKIE_SECRET` | `openssl rand -base64 48` |

`deploy/secrets.prod.env` is gitignored. Never commit it.

## Step 2 — Deploy Cloud Run + push secrets

```bash
cd panelchat
./deploy/deploy.sh
```

The script:

1. Validates the secrets file has all five values.
2. Uploads each as `PANELCHAT_*` to GCP Secret Manager (creating or versioning).
3. Builds the Dockerfile and rolls a new Cloud Run revision of `panelchat-server`.
4. Probes `/panelchat-api/health` and fails loudly if it doesn't respond.
5. Prints the Cloud Run service URL.

Smoke-test the Cloud Run URL directly:

```bash
CLOUD_RUN_URL=$(gcloud --project=cts-development-485012 run services describe panelchat-server --region europe-west1 --format='value(status.url)')
curl -fsS "$CLOUD_RUN_URL/panelchat-api/health"
```

Should return `{"ok":true,"activeSessionId":"…","state":"…"}`.

## Step 3 — Patch the root firebase.json

Merge the additions from `panelchat/deploy/firebase-hosting-patch.json` into the root `firebase.json` `hosting` block. The full result's `rewrites` array should include (alongside existing entries):

```json
{ "source": "/panelchat-api/**",        "run":         { "serviceId": "panelchat-server", "region": "europe-west1" } },
{ "source": "/panelchat/sessions/**",   "destination": "/panelchat/web/visitor/index.html" },
{ "source": "/panelchat/admin/**",      "destination": "/panelchat/web/admin/$1" },
{ "source": "/panelchat/**",            "destination": "/panelchat/web/visitor/$1" }
```

And the `ignore` array should include (so build doesn't try to ship the server source):

```
"panelchat/server/**",
"panelchat/dev-audio/**",
"panelchat/Dockerfile",
"panelchat/.gcloudignore",
"panelchat/deploy/**",
"panelchat/README.md",
"panelchat/DEPLOY.md",
"panelchat/PARTNER.md",
"panelchat/.gitignore"
```

## Step 4 — Preview channel deploy

**Do not promote to live yet.** Push the firebase.json change to a preview channel first:

```bash
firebase hosting:channel:deploy panelchat-preview --project=cts-development-485012 --expires=2d
```

Walk through on the preview URL:

1. `/panelchat/` — visitor feed loads.
2. `/panelchat/admin/` — log in with the new admin password.
3. Create a new rehearsal session, hit **Start**, watch the opener fire (no live audio needed).
4. Toggle **Audience Asks** on, open the visitor URL in an incognito tab, submit a question.
5. **End session**.

Cloud Run logs: `gcloud run services logs read panelchat-server --region europe-west1`. Session log: `/panelchat/admin/log.html`.

## Step 5 — Promote to live

```bash
firebase deploy --only hosting --project=cts-development-485012
```

Verify:

```bash
curl -fsS https://creativethinkingsystems.com/panelchat-api/health
```

## Rollback

```bash
firebase hosting:releases:list --project=cts-development-485012
firebase hosting:releases:rollback <release-id> --project=cts-development-485012

gcloud run services update-traffic panelchat-server --to-revisions=<previous-revision>=100 --region=europe-west1
```

## Spend caps (your responsibility)

Before any live event, set per-day spend caps in each provider's console (Anthropic, OpenAI, Gemini). A 90-minute panel at 2–3 posts/min ≈ 200 generations, ~100 input tokens + ~30 output tokens each. Rounding error in $, but cap anyway.

## Podcast prerequisites

The admin can generate an MP3 podcast from a session's transcript via Google's NotebookLM Enterprise Podcast API. Three GCP prerequisites:

1. **Allowlist.** The API is GA-with-allowlist. Project `cts-development-485012` must be approved by your Google Cloud sales contact. Without this the API returns 403 `PERMISSION_DENIED`.
2. **API enablement.** Run once per project:
   ```bash
   gcloud --project=cts-development-485012 services enable discoveryengine.googleapis.com
   ```
3. **IAM role on the Cloud Run service account.** Grant `roles/discoveryengine.podcastApiUser`:
   ```bash
   PROJECT=cts-development-485012
   PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
   SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
   gcloud projects add-iam-policy-binding "$PROJECT" \
       --member="serviceAccount:${SA}" \
       --role="roles/discoveryengine.podcastApiUser"
   ```

The Podcast admin form exposes title, description, focus (free-text narrative direction), length (SHORT 4–5 min / STANDARD ~10 min), and whether to include bot chat posts as additional context. What is *not* exposed (API limitation): voice/persona, custom duration in minutes, audio format other than MP3.
