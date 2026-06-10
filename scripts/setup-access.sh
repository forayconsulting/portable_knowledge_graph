#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Cloudflare Access Setup for Knowledge Graph MCP Server
# ============================================================================
#
# This script automates what it can via Wrangler CLI and provides exact
# manual instructions for steps that require the Cloudflare Zero Trust dashboard.
#
# Prerequisites:
#   - wrangler CLI authenticated (run: wrangler login)
#   - Cloudflare Zero Trust plan active on your account
#   - A Google Cloud project with OAuth credentials (for Google IdP)
#
# Usage:
#   chmod +x scripts/setup-access.sh
#   ./scripts/setup-access.sh
#
# ============================================================================

WORKER_DOMAIN="${WORKER_DOMAIN:-kg-mcp.foray-consulting.workers.dev}"
ALLOWED_EMAIL_DOMAIN="${ALLOWED_EMAIL_DOMAIN:-foray-consulting.com}"

echo "=========================================="
echo " KG-MCP Cloudflare Access Setup"
echo "=========================================="
echo ""
echo "Worker domain:    $WORKER_DOMAIN"
echo "Allowed domain:   @$ALLOWED_EMAIL_DOMAIN"
echo ""

# --------------------------------------------------------------------------
# Step 1: Create the Access Application (via CLI if available)
# --------------------------------------------------------------------------
echo "--- Step 1: Create Access Application ---"
echo ""

if npx wrangler zero-trust access applications create \
  --name "Knowledge Graph MCP" \
  --domain "${WORKER_DOMAIN}/authorize" \
  --type self-hosted \
  --session-duration "24h" 2>/dev/null; then
  echo "  Access Application created via CLI."
else
  echo "  CLI command not available or failed. Create manually:"
  echo ""
  echo "  1. Open https://one.dash.cloudflare.com → Zero Trust → Access → Applications"
  echo "  2. Click 'Add an application' → 'Self-hosted'"
  echo "  3. Set:"
  echo "     - Application name:  Knowledge Graph MCP"
  echo "     - Session duration:  24 hours"
  echo "     - Application domain: ${WORKER_DOMAIN}"
  echo "     - Path:              /authorize"
  echo "  4. Click 'Next'"
fi
echo ""

# --------------------------------------------------------------------------
# Step 1b: Create the Access Application for the graph visualizer (/viz)
# --------------------------------------------------------------------------
echo "--- Step 1b: Create Access Application for the visualizer ---"
echo ""

if npx wrangler zero-trust access applications create \
  --name "Knowledge Graph Viz" \
  --domain "${WORKER_DOMAIN}/viz" \
  --type self-hosted \
  --session-duration "24h" 2>/dev/null; then
  echo "  Viz Access Application created via CLI."
else
  echo "  CLI command not available or failed. Create manually:"
  echo ""
  echo "  1. Open https://one.dash.cloudflare.com → Zero Trust → Access → Applications"
  echo "  2. Click 'Add an application' → 'Self-hosted'"
  echo "  3. Set:"
  echo "     - Application name:  Knowledge Graph Viz"
  echo "     - Session duration:  24 hours"
  echo "     - Application domain: ${WORKER_DOMAIN}"
  echo "     - Path:              /viz"
  echo "       (verify subpaths are covered after saving — if /viz/<graph-id>"
  echo "        is not intercepted by Access, change the path to: viz*)"
  echo "  4. Attach the same 'Allow company emails' policy as the MCP app"
  echo "  5. Click 'Next' → 'Add application'"
  echo ""
  echo "  Without this app, /viz requests have no Access email header and 401."
fi
echo ""

# --------------------------------------------------------------------------
# Step 2: Create the Access Policy (via CLI if available)
# --------------------------------------------------------------------------
echo "--- Step 2: Create Access Policy ---"
echo ""

if npx wrangler zero-trust access policies create \
  --application-name "Knowledge Graph MCP" \
  --name "Allow company emails" \
  --decision Allow \
  --include-email-domain "$ALLOWED_EMAIL_DOMAIN" 2>/dev/null; then
  echo "  Access Policy created via CLI."
else
  echo "  CLI command not available or failed. Create manually:"
  echo ""
  echo "  On the same application creation page (or edit the application):"
  echo "  1. Policy name:  Allow company emails"
  echo "  2. Action:       Allow"
  echo "  3. Under 'Configure rules' → Include:"
  echo "     - Selector: 'Emails ending in'"
  echo "     - Value:    @${ALLOWED_EMAIL_DOMAIN}"
  echo "  4. Click 'Next' → 'Add application'"
fi
echo ""

# --------------------------------------------------------------------------
# Step 3: Enable Instant Auth (skip identity provider selection page)
# --------------------------------------------------------------------------
echo "--- Step 3: Enable Instant Auth ---"
echo ""
echo "  This must be configured in the dashboard:"
echo ""
echo "  1. Open https://one.dash.cloudflare.com → Zero Trust → Settings → Authentication"
echo "  2. Under 'Login page', toggle on 'Instant Auth'"
echo "     (This skips the IdP selector and redirects directly to Google)"
echo ""

# --------------------------------------------------------------------------
# Step 4: Connect Google as an Identity Provider (MANUAL - requires Google Console)
# --------------------------------------------------------------------------
echo "--- Step 4: Connect Google Identity Provider ---"
echo ""
echo "  This step CANNOT be automated. It requires credentials from the Google Cloud Console."
echo ""
echo "  A. Create Google OAuth credentials:"
echo "     1. Open https://console.cloud.google.com/apis/credentials"
echo "     2. Click 'Create Credentials' → 'OAuth client ID'"
echo "     3. Application type: 'Web application'"
echo "     4. Name: 'Cloudflare Access - KG MCP'"
echo "     5. Authorized redirect URIs:"
echo "        Add: https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback"
echo "        (Replace <your-team-name> with your Zero Trust team name)"
echo "     6. Click 'Create'"
echo "     7. Copy the Client ID and Client Secret"
echo ""
echo "  B. Add Google as a login method in Cloudflare Zero Trust:"
echo "     1. Open https://one.dash.cloudflare.com → Zero Trust → Settings → Authentication"
echo "     2. Under 'Login methods', click 'Add new'"
echo "     3. Select 'Google'"
echo "     4. Paste the Client ID from step A.7"
echo "     5. Paste the Client Secret from step A.7"
echo "     6. Click 'Save'"
echo ""

# --------------------------------------------------------------------------
# Step 5: Set Worker secrets
# --------------------------------------------------------------------------
echo "--- Step 5: Set Worker Secrets ---"
echo ""
echo "  Run the following commands to set the required secrets:"
echo ""
echo "  npx wrangler secret put NEO4J_URL"
echo "  npx wrangler secret put NEO4J_AUTH"
echo "  npx wrangler secret put CF_ACCESS_TEAM_DOMAIN"
echo ""

echo "=========================================="
echo " Setup complete. Deploy with:"
echo "   npx wrangler deploy"
echo "=========================================="
