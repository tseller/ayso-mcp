#!/usr/bin/env bash
set -euo pipefail

# Deploy billcom-mcp to Cloud Run
# Secrets are stored in Secret Manager (project mcp-servers-487419)
# Auth is handled at app level via OAuth 2.0 (Google as IdP)

SERVICE_URL="https://billcom-mcp-733083913968.us-central1.run.app"

# QBO_REFRESH_TOKEN is no longer wired as an env-var; the app reads it directly
# from Secret Manager (SecretManagerTokenStore) so rotations write back safely
# across concurrent instances.

# NOTE on secret rotation: every secret below is pinned to :latest, which Cloud
# Run resolves at *instance start*. Disabling a secret's latest version bricks
# all new instance startups (this caused the 2026-07-23 outage — every scale-up
# 5xx'd until an enabled version existed). When rotating: add the new enabled
# version first, and never disable the old one until the new one is live.

# GMAIL_REFRESH_TOKENS (JSON: account email -> refresh token) powers the Gmail
# source on qbo_attach_file. Mint additional accounts with `npm run gmail:link`
# and merge them into the secret.

# SPORTSCONNECT_USERNAME / SPORTSCONNECT_PASSWORD are Tim's own Sports Connect
# (Stack Sports) admin login; they power the read-only sportsconnect_* tools.

gcloud run deploy billcom-mcp \
  --account=tseller@gmail.com \
  --project=mcp-servers-487419 \
  --source . \
  --region us-central1 \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars="MCP_TRANSPORT=http,SERVER_URL=${SERVICE_URL},ALLOWED_EMAILS=tseller@gmail.com" \
  --set-secrets="BILLCOM_API_BASE_URL=BILLCOM_API_BASE_URL:latest,BILLCOM_USERNAME=BILLCOM_USERNAME:latest,BILLCOM_PASSWORD=BILLCOM_PASSWORD:latest,BILLCOM_ORGANIZATION_ID=BILLCOM_ORGANIZATION_ID:latest,BILLCOM_DEV_KEY=BILLCOM_DEV_KEY:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,INTUIT_CLIENT_ID=INTUIT_CLIENT_ID:latest,INTUIT_CLIENT_SECRET=INTUIT_CLIENT_SECRET:latest,QBO_REALM_ID=QBO_REALM_ID:latest,MCP_API_TOKEN=MCP_API_TOKEN:latest,DIVVY_API_TOKEN=DIVVY_API_TOKEN:latest,GMAIL_REFRESH_TOKENS=GMAIL_REFRESH_TOKENS:latest,SPORTSCONNECT_USERNAME=SPORTSCONNECT_USERNAME:latest,SPORTSCONNECT_PASSWORD=SPORTSCONNECT_PASSWORD:latest"
