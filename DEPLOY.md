# Deployment Runbook

This guide covers deploying the multi-tenant Knowledge Graph platform from scratch in any Cloudflare + Railway environment.

## Prerequisites

- **Cloudflare account** with Workers, Durable Objects, and Zero Trust (Access) enabled
- **Railway account** (Pro plan — needed for API access and Docker deployments)
- **CLIs authenticated**: `wrangler login` and `railway login`
- **Node.js 22+** and `npm ci` completed

## 1. Generate secrets

```bash
# Encryption key shared by both workers (AES-256-GCM)
openssl rand -hex 32
# Save this value — you'll use it twice below

# Railway API token (NOT the CLI session)
# Go to https://railway.com/account/tokens
# Create a token named "kg-factory-provisioner"
# Copy the token value
```

## 2. Deploy the Factory Worker (first)

The Factory Worker owns the `GraphRegistry` Durable Object. It **must deploy before** the MCP Worker, which references it via `script_name`.

```bash
npx wrangler deploy -c wrangler.factory.jsonc
```

### Set Factory secrets

```bash
npx wrangler secret put GRAPH_ENCRYPTION_KEY -c wrangler.factory.jsonc
# Paste the hex string from step 1

npx wrangler secret put RAILWAY_API_TOKEN -c wrangler.factory.jsonc
# Paste the Railway API token from step 1

npx wrangler secret put FACTORY_ADMINS -c wrangler.factory.jsonc
# Comma-separated admin emails, e.g.: alice@example.com,bob@example.com

npx wrangler secret put CF_ACCESS_TEAM_DOMAIN -c wrangler.factory.jsonc
# Your Cloudflare Zero Trust team domain, e.g.: myteam.cloudflareaccess.com
```

### Verify

```bash
curl https://kg-factory.<your-domain>.workers.dev/health
# Expected: {"status":"ok","service":"kg-factory"}
# If you get a 302, Cloudflare Access is intercepting — see step 4
```

## 3. Deploy the MCP Worker (second)

```bash
npm run deploy
# Builds the viz frontend (viz-app/ -> public/viz) and then runs wrangler deploy.
# If deploying with npx wrangler deploy directly, run `npm run build:viz` first
# or the assets upload will ship a stale/missing viz bundle.
```

### Set MCP Worker secrets

```bash
npx wrangler secret put GRAPH_ENCRYPTION_KEY
# Same key as the Factory Worker — must match exactly
```

### Verify

```bash
curl https://kg-mcp.<your-domain>.workers.dev/health
# Expected: {"status":"ok","neo4j":"connected","version":"5.x.x",...}

curl -s -o /dev/null -w "%{http_code}" https://kg-mcp.<your-domain>.workers.dev/viz/api/default/meta
# Expected: 401 until the /viz Access destination from step 4 exists,
# then 200 when opened from an Access-authenticated browser session.
```

## 4. Configure Cloudflare Access

Both workers need to be behind the same Cloudflare Access application so that authenticated user emails are available.

### Create or update the Access application

1. Open **https://one.dash.cloudflare.com** → Zero Trust → Access controls → Applications
2. Create a **Self-hosted** application (or edit an existing one)
3. Add three **Destinations** (public hostnames):
   - `kg-mcp.<your-domain>.workers.dev` with path `/authorize`
   - `kg-mcp.<your-domain>.workers.dev` with path `/viz` (the graph visualizer — without this destination, `/viz` requests carry no Access email header and return 401; if subpaths like `/viz/<graph-id>` are not intercepted, use path `viz*` instead)
   - `kg-factory.<your-domain>.workers.dev` (no path — protect all routes)
4. Add an **Allow** policy for your email domain (e.g., "Emails ending in @yourcompany.com")
5. Save

### Create a Service Token (for programmatic access)

1. Go to Zero Trust → Access controls → **Service credentials** → Service Tokens
2. Click **Create Service Token**, name it (e.g., `kg-deploy-test`)
3. Copy the **CF-Access-Client-Id** and **CF-Access-Client-Secret**

### Attach the Service Token policy to the application

1. Go to Access controls → **Policies** (global policies page)
2. Click **Add a policy** → name it "Service Token Access"
3. Action: **Service Auth**, Include: **Service Token** → select your token
4. Save the policy
5. Go back to **Applications** → your app → **Policies** tab
6. Click **"Add existing policy"** → select "Service Token Access"
7. Save

## 5. Run the smoke test

```bash
CF_ACCESS_CLIENT_ID=<your-client-id> \
CF_ACCESS_CLIENT_SECRET=<your-client-secret> \
npx tsx scripts/test-deploy.ts
```

This provisions a test graph on Railway (~7 minutes), verifies the full lifecycle, then tears it down. All 7 checks should pass:

```
✓ Factory /health returns 200
✓ MCP /health returns 200 with neo4j connected
✓ POST /graphs returns 202
✓ Provisioning reaches 'ready' state
✓ GET /graphs lists the provisioned graph
✓ DELETE /graphs tears down cleanly
✓ GET /graphs/{id} returns 404 after deletion
```

## 6. Provision a real graph

```bash
curl -X POST https://kg-factory.<domain>.workers.dev/graphs \
  -H "CF-Access-Client-Id: <id>" \
  -H "CF-Access-Client-Secret: <secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "graph_id": "my-project",
    "display_name": "My Project Knowledge Graph",
    "users": {"@yourcompany.com": "writer"},
    "default_role": null
  }'
```

Poll status:

```bash
curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
  https://kg-factory.<domain>.workers.dev/graphs/my-project
```

Once state is `"ready"`, connect Claude Desktop to:
```
https://kg-mcp.<domain>.workers.dev/mcp/my-project
```

## Troubleshooting

### Provisioning stuck at "provisioning"

Check the Cloudflare Workflow status:

```bash
npx wrangler workflows instances describe provision-graph-workflow latest -c wrangler.factory.jsonc
```

Common causes:
- **Neo4j 502 errors**: Missing `PORT=7474` environment variable (fixed in current code)
- **Railway API 504**: Transient timeout — the workflow retries automatically
- **Railway auth failure**: Invalid or expired `RAILWAY_API_TOKEN`

### Service token returns 302

The service token policy must be **attached to the Access application**, not just created as a global policy. Check: Applications → your app → Policies tab — the "Service Token Access" policy should be listed there.

### Orphaned Railway projects

If provisioning fails, the workflow's compensating teardown deletes the Railway project. If that also fails (or the workflow is terminated), check Railway dashboard for projects named `kg-<graph-id>` and delete them manually.

### MCP Worker can't reach registry

Error: "Graph not found" when connecting to `/mcp/<graph-id>` — the cross-worker DO binding may not be deployed. Redeploy the factory worker first, then the MCP worker:

```bash
npx wrangler deploy -c wrangler.factory.jsonc
npx wrangler deploy
```

## CI/CD

The GitHub Actions workflow (`.github/workflows/ci.yml`) deploys both workers on push to `main`. Order: factory first, MCP second. Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Worker secrets (GRAPH_ENCRYPTION_KEY, RAILWAY_API_TOKEN, etc.) are set once via `wrangler secret put` and persist across deploys.
