# Veltrix MCP Server

Connect AI assistants (Claude Desktop, Claude Code, or any MCP client) to your Veltrix tenant through the [Model Context Protocol](https://modelcontextprotocol.io).

**Propose-only by design.** The MCP server exposes the same governed pipeline the portal uses: an assistant can draft and validate configuration canvases, submit them for approval, deploy *already-approved* canvases, and read pipeline/drift/compliance state — but **approval decisions always stay with humans in the Veltrix portal**. There are deliberately no approve/reject, credential, user-management, or API-key-management tools.

All authorization is enforced by the Veltrix API itself: the server forwards your role-bound `vltx_` API key on every call, so tenant isolation, RBAC, tier quotas, and rate limits apply exactly as they do for any other API client.

## Prerequisites

1. A running Veltrix instance (`VELTRIX_API_URL`, default `http://localhost:5000`).
2. A Veltrix API key with a bound role (portal → Settings → API Keys). Keys without a role are rejected (fail closed). Grant the role only the permissions the assistant should have — e.g. `configuration-canvas:read` for a read-only analyst session.

## Install & build

```bash
cd mcp
npm install
npm run build
```

## Usage

### stdio (Claude Desktop / Claude Code)

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "veltrix": {
      "command": "node",
      "args": ["C:/Projects/Veltrix/mcp/dist/index.js"],
      "env": {
        "VELTRIX_API_URL": "https://app.veltrixsecops.com",
        "VELTRIX_API_KEY": "vltx_..."
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add veltrix -e VELTRIX_API_URL=https://app.veltrixsecops.com -e VELTRIX_API_KEY=vltx_... -- node C:/Projects/Veltrix/mcp/dist/index.js
```

### Streamable HTTP (remote / multi-tenant)

```bash
# binds 127.0.0.1 by default; pass --host 0.0.0.0 (or VELTRIX_MCP_HOST) to expose it deliberately
VELTRIX_API_URL=https://app.veltrixsecops.com node dist/index.js --http --port 5100 --host 0.0.0.0
```

The server runs statelessly on `POST /mcp`; every request must carry the caller's key:

```
Authorization: Bearer vltx_...     (or x-api-key: vltx_...)
```

One process serves many tenants — the key on each request determines the tenant, and the Veltrix API enforces isolation. Health probe: `GET /healthz`.

In the standard Veltrix production deployment this runs automatically as the `veltrix-mcp` PM2 service on loopback `:5100`, proxied by nginx at `https://app.<your-domain>/mcp` (see `scripts/direct-deploy.sh` and `nginx/default.conf`).

### Tier entitlement

MCP access is a paid-tier capability (`mcpAccessEnabled` — off on the free tier). The server checks `GET /api/subscription/mcp-access` once per session and refuses tool calls with an upgrade message when the tenant's plan doesn't include it. Platforms predating the endpoint (404) are treated as open.

## Tools

| Group | Tools |
|---|---|
| Identity | `veltrix_whoami` |
| Canvases | `veltrix_list_canvases`, `veltrix_get_canvas`, `veltrix_create_canvas`, `veltrix_update_canvas`, `veltrix_submit_canvas_for_approval`, `veltrix_get_canvas_approvals` |
| Pipeline | `veltrix_validate_canvas`, `veltrix_deploy_canvas`, `veltrix_list_canvas_deployments`, `veltrix_get_deployment`, `veltrix_rollback_deployment`, `veltrix_pipeline_summary`, `veltrix_environment_matrix` |
| Drift & reports | `veltrix_list_drift`, `veltrix_check_canvas_drift`, `veltrix_compliance_report`, `veltrix_security_overview` |
| Catalog | `veltrix_list_apps`, `veltrix_list_environments`, `veltrix_list_components` |

A typical assistant workflow: `veltrix_whoami` → `veltrix_pipeline_summary` → draft with `veltrix_create_canvas` → `veltrix_validate_canvas` → `veltrix_submit_canvas_for_approval` → (a human approves in the portal) → `veltrix_deploy_canvas` → `veltrix_get_deployment`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `VELTRIX_API_URL` | `http://localhost:5000` | Base URL of the Veltrix API |
| `VELTRIX_API_KEY` | — | API key (required for stdio; HTTP fallback) |
| `VELTRIX_MCP_PORT` / `--port` | `5100` | HTTP mode port |
| `VELTRIX_MCP_HOST` / `--host` | `127.0.0.1` | HTTP mode bind host (loopback by default — this endpoint forwards API keys) |
| `VELTRIX_API_TIMEOUT_MS` | `30000` | Per-request API timeout (kept under MCP client timeouts so failures surface as readable errors) |

## Development

```bash
npm run dev        # stdio against VELTRIX_API_URL
npm test           # jest
npm run smoke      # live e2e against a running dev stack (see scripts/e2e-smoke.js)
```

Attribution note: actions performed with an API key are attributed in the audit trail to the tenant's non-loginable **"API Integration"** system user (provisioned automatically on first API-key use).
