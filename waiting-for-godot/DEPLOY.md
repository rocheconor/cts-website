# Deploying Waiting for Godot

This walks through deploying the orchestrator service to Cloud Run and wiring it to the existing `creativethinkingsystems.com` Firebase Hosting site. **Read before running.** Expect about 15 minutes with you watching the rollout.

## What this deploys

- A new Cloud Run service `wfg-server` in `europe-west1` running `waiting-for-godot/server/`.
- Five new secrets in GCP Secret Manager (`WFG_ANTHROPIC_API_KEY`, `WFG_OPENAI_API_KEY`, `WFG_GEMINI_API_KEY`, `WFG_ADMIN_PASSWORD`, `WFG_SESSION_COOKIE_SECRET`).
- Hosting rewrites added to the root `firebase.json` that route:
  - `/wfg-api/**` → the Cloud Run service
  - `/wfg/sessions/<id>/` → the visitor template (so archive URLs render)
  - `/waitingforgodot/**` and `/wfg/**` → static files in `waiting-for-godot/web/`

What it does **not** touch: existing `/aireadiness`, newsletter, workbook handlers. Hosting rewrites are additive.

## Prereqs

- `gcloud` CLI authenticated against `cts-development-485012` (it already is — ADC is set).
- `firebase` CLI authenticated for the same project.
- All five production secrets ready to paste (see step 1).

## Step 1 — Production secrets

Copy the template and fill it in:

```bash
cd waiting-for-godot
cp deploy/secrets.prod.env.example deploy/secrets.prod.env
$EDITOR deploy/secrets.prod.env
```

You need:

| Secret | How to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys → **create new** (rotate the one used in dev) |
| `OPENAI_API_KEY` | platform.openai.com → API keys → **create new** (rotate) |
| `GEMINI_API_KEY` | aistudio.google.com → API keys → **create new** (rotate) |
| `ADMIN_PASSWORD` | pick a real one (12+ chars). Operator console password. |
| `SESSION_COOKIE_SECRET` | `openssl rand -base64 48` |

`deploy/secrets.prod.env` is gitignored. Never commit it.

## Step 2 — Deploy Cloud Run + push secrets

```bash
cd waiting-for-godot
./deploy/deploy.sh
```

The script:
1. Validates the secrets file has all five values.
2. Uploads each to GCP Secret Manager (creating or versioning).
3. Builds the Dockerfile and rolls a new Cloud Run revision.
4. Probes `/wfg-api/health` against the Cloud Run URL and fails loudly if it doesn't respond.
5. Prints the Cloud Run service URL.

Smoke-test the Cloud Run URL directly before going further:

```bash
CLOUD_RUN_URL=$(gcloud --project=cts-development-485012 run services describe wfg-server --region europe-west1 --format='value(status.url)')
curl -fsS "$CLOUD_RUN_URL/wfg-api/health"
```

Should return `{"ok":true,"activeSessionId":"…","state":"…"}`.

## Step 3 — Patch the root firebase.json

Open the repo root's `firebase.json` and merge in the additions from `waiting-for-godot/deploy/firebase-hosting-patch.json`. The result's `hosting` block should look like:

```json
{
  "hosting": {
    "public": ".",
    "ignore": [
      "firebase.json", ".firebase", ".firebaserc", ".git", ".gitignore",
      "design/images/dash_3_original.jpg",
      "design/images/Gemini_Generated_Image_4c4yat4c4yat4c4y.png",
      "node_modules", "build/**", "functions/**",
      "aireadiness/aird-brief.md", "aireadiness/aird-content.md",
      "AI_Readiness_Assessment__Gate_Theatre.pdf",
      "business-plan/**",
      "firestore.rules", "firestore.indexes.json", "storage.rules",
      "waiting-for-godot/server/**",
      "waiting-for-godot/docs/**",
      "waiting-for-godot/dev-audio/**",
      "waiting-for-godot/firebase.json",
      "waiting-for-godot/.firebaserc",
      "waiting-for-godot/firestore.rules",
      "waiting-for-godot/README.md",
      "waiting-for-godot/.gitignore",
      "waiting-for-godot/deploy/**"
    ],
    "rewrites": [
      { "source": "/api/workbook-request", "function": { "functionId": "workbookRequest", "region": "europe-west1" } },
      { "source": "/api/newsletter-subscribe", "function": { "functionId": "newsletterSubscribe", "region": "europe-west1" } },
      { "source": "/api/submit-assessment", "function": { "functionId": "submitAssessment", "region": "europe-west1" } },
      { "source": "/wfg-api/**", "run": { "serviceId": "wfg-server", "region": "europe-west1" } },
      { "source": "/wfg/sessions/**", "destination": "/waiting-for-godot/web/waitingforgodot/index.html" },
      { "source": "/waitingforgodot/**", "destination": "/waiting-for-godot/web/waitingforgodot/$1" },
      { "source": "/wfg/**", "destination": "/waiting-for-godot/web/wfg/$1" }
    ],
    "headers": [ /* unchanged */ ],
    "redirects": [
      { "source": "/aird", "destination": "/aireadiness", "type": 301 },
      { "source": "/aird/:rest*", "destination": "/aireadiness/:rest", "type": 301 },
      { "source": "/wfg", "destination": "/waitingforgodot", "type": 301 }
    ]
  }
}
```

## Step 4 — Preview channel deploy

**Do not promote to live yet.** Push the firebase.json change to a preview channel first:

```bash
firebase hosting:channel:deploy wfg-preview --project=cts-development-485012 --expires=2d
```

This returns a temporary preview URL like `https://cts-development-485012--wfg-preview-XXXX.web.app/`. Walk through:

1. Open the preview URL + `/waitingforgodot/` — should show the empty/active session.
2. Open `/wfg/admin/` — log in with the new admin password.
3. Create a new rehearsal session, hit **Start**, watch the opener fire.
4. Toggle Godot Asks on, open the visitor URL in an incognito tab, submit a question.
5. End the session.

If any step fails: do not promote. Investigate Cloud Run logs (`gcloud run services logs read wfg-server --region europe-west1`) and the session log at `/wfg/admin/log.html`.

## Step 5 — Promote to live

```bash
firebase hosting:clone cts-development-485012:wfg-preview cts-development-485012:live
```

Or, equivalently, redeploy the same firebase.json to the live channel:

```bash
firebase deploy --only hosting --project=cts-development-485012
```

Verify with the real domain:

```bash
curl -fsS https://creativethinkingsystems.com/wfg-api/health
```

The live event runs on:
- Visitor feed: <https://creativethinkingsystems.com/waitingforgodot/>
- Admin console: <https://creativethinkingsystems.com/wfg/admin/>

## Rollback

If anything goes wrong post-promotion:

```bash
# Roll back Firebase Hosting to the previous release:
firebase hosting:releases:list --project=cts-development-485012
firebase hosting:releases:rollback <release-id> --project=cts-development-485012

# Roll back the Cloud Run service to a previous revision:
gcloud run services update-traffic wfg-server --to-revisions=<previous-revision>=100 --region=europe-west1
```

The Cloud Run service can also be paused or have traffic zeroed (`--to-revisions=<rev>=0`) which effectively disables `/wfg-api/**` without touching Firebase.

## Spend caps (your responsibility)

Before the event, set per-day spend caps in each provider's console:

- Anthropic: console.anthropic.com → Plans & Billing → Usage limits
- OpenAI: platform.openai.com → Settings → Limits → Set monthly + daily caps
- Gemini: aistudio.google.com → set quota via Cloud Console for the API in `cts-development-485012`

A 90-minute panel at 2-3 posts/min ≈ 200 generations total. Each generation is ~100 input tokens + ~30 output tokens. Real cost is rounding-error in $ but worth capping anyway.
