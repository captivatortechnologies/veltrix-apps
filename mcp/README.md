# Veltrix MCP Server

Connect AI assistants (Claude Code, Claude Desktop, Cursor, or any MCP client) to your Veltrix tenant through the [Model Context Protocol](https://modelcontextprotocol.io).

**Propose-only, enforced by the platform.** An assistant can draft and validate configuration canvases, submit them for approval, deploy *already-approved* canvases, and read pipeline, drift and compliance state. **Approval decisions stay with people in the Veltrix portal.** This server has no approve or reject tool, and the Veltrix API itself refuses approval decisions made with an API key — so the guarantee holds even for a caller that bypasses this server and uses the key directly.

All authorization is enforced by the Veltrix API: the server forwards your role-bound `vltx_` API key on every call, so tenant isolation, RBAC, tier quotas and rate limits apply exactly as they do for any other API client.

## Quick start

1. In the Veltrix portal, create an API key bound to a role (Settings → API Keys). Keys without a role are rejected. Give the role only what the assistant should be able to do — see [Role recipes](#role-recipes).
2. Add the server to your MCP client.

**Claude Code**

```bash
claude mcp add veltrix \
  -e VELTRIX_API_URL=https://app.veltrixsecops.com \
  -e VELTRIX_API_KEY=vltx_... \
  -- npx -y @veltrixsecops/mcp-server
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` / `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "veltrix": {
      "command": "npx",
      "args": ["-y", "@veltrixsecops/mcp-server"],
      "env": {
        "VELTRIX_API_URL": "https://app.veltrixsecops.com",
        "VELTRIX_API_KEY": "vltx_..."
      }
    }
  }
}
```

**Hosted endpoint (no install)** — for clients that can send a header to a remote Streamable HTTP server:

```bash
claude mcp add --transport http veltrix https://app.veltrixsecops.com/mcp \
  --header "Authorization: Bearer vltx_..."
```

Clients that only support OAuth for remote servers (for example custom connectors added in a web UI) cannot use the hosted endpoint yet; use the stdio setup above.

## Tools

| Group | Tools |
|---|---|
| Identity | `veltrix_whoami` |
| Catalog | `veltrix_list_apps`, `veltrix_get_app`, `veltrix_get_config_type_schema`, `veltrix_list_environments`, `veltrix_get_environment_policy`, `veltrix_list_components` |
| Canvases | `veltrix_list_canvases`, `veltrix_get_canvas`, `veltrix_create_canvas`, `veltrix_update_canvas`, `veltrix_duplicate_canvas`, `veltrix_export_canvas`, `veltrix_delete_canvas` |
| Versions | `veltrix_get_canvas_history`, `veltrix_get_canvas_version`, `veltrix_compare_canvas_versions`, `veltrix_restore_canvas_version` |
| Approvals | `veltrix_list_approvers`, `veltrix_submit_canvas_for_approval`, `veltrix_get_canvas_approvals` |
| Review | `veltrix_list_canvas_comments`, `veltrix_add_canvas_comment` |
| Pipeline | `veltrix_validate_canvas`, `veltrix_get_pipeline_status`, `veltrix_deploy_canvas`, `veltrix_list_canvas_deployments`, `veltrix_get_deployment`, `veltrix_pause_deployment`, `veltrix_resume_deployment`, `veltrix_promote_deployment`, `veltrix_rollback_deployment`, `veltrix_pipeline_summary`, `veltrix_environment_matrix` |
| Drift | `veltrix_list_drift`, `veltrix_get_canvas_drift`, `veltrix_check_canvas_drift`, `veltrix_detect_drift`, `veltrix_resolve_drift`, `veltrix_get_drift_schedule`, `veltrix_set_drift_schedule`, `veltrix_clear_drift_schedule` |
| Reports | `veltrix_compliance_report`, `veltrix_security_overview`, `veltrix_audit_logs` |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can auto-approve reads and confirm writes.

**Deliberately absent:** approve / reject / set-status, credentials and secrets, user / role / API-key management, app install / enable, and environment or component writes.

A typical flow: `veltrix_whoami` → `veltrix_list_apps` → `veltrix_get_app` → `veltrix_get_config_type_schema` → `veltrix_create_canvas` → `veltrix_validate_canvas` → `veltrix_list_approvers` → `veltrix_submit_canvas_for_approval` → *(a person approves in the portal)* → `veltrix_deploy_canvas` → `veltrix_get_deployment`.

## Prompts

| Prompt | What it does |
|---|---|
| `veltrix_propose_change` | Drafts, validates and submits a change for human approval, then stops |
| `veltrix_triage_drift` | Explains unresolved drift and recommends an action per item, read-only until you choose |
| `veltrix_deployment_report` | Reports what is deployed where and what needs attention |

## Role recipes

The key's bound role decides what the assistant can do. Start narrow.

| Use | Permissions on the role |
|---|---|
| Read-only analyst | `configuration-canvas:read` (canvases, pipeline, drift, environments), `component:read`, `report:read` |
| Change author | the above, plus `configuration-canvas:write`, `user:read` (to look up approvers), and read on the configuration types it should author |
| Operator | the above; deploy, pause, promote and rollback use `configuration-canvas:write` and are still gated by approval and environment policy |

`veltrix_whoami` confirms the key is valid, when it expires, and which tenant and plan it belongs to. It does not list permissions; a tool that needs one the role lacks returns a 403 that says so.

Changes made with a key are attributed in the audit trail to that key's own identity, shown as **API: \<key name\>**, so reviewers can see which assistant or integration proposed a change. That identity cannot sign in and cannot be named as an approver.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `VELTRIX_API_URL` | `http://localhost:5000` | Base URL of the Veltrix API |
| `VELTRIX_API_KEY` | — | API key. Required for stdio; optional server-side fallback in HTTP mode |
| `--http` | off | Serve Streamable HTTP on `POST /mcp` instead of stdio |
| `VELTRIX_MCP_PORT` / `--port` | `5100` | HTTP port |
| `VELTRIX_MCP_HOST` / `--host` | `127.0.0.1` | HTTP bind address. Loopback by default, because this endpoint forwards API keys |
| `VELTRIX_MCP_ALLOWED_HOSTS` | — | Comma-separated `Host` header allowlist for HTTP mode (hostnames, no ports) |
| `VELTRIX_API_TIMEOUT_MS` | `30000` | Per-request API timeout, kept under MCP client timeouts so failures read clearly |
| `VELTRIX_MCP_MAX_RESULT_CHARS` | `60000` | Cap on one tool result. Larger responses are truncated with a notice telling the assistant how to narrow the request |

`veltrix-mcp --help` and `veltrix-mcp --version` print usage and the version.

## Self-hosting the HTTP transport

```bash
VELTRIX_API_URL=https://veltrix.internal.example.com \
VELTRIX_MCP_ALLOWED_HOSTS=mcp.example.com \
npx -y @veltrixsecops/mcp-server --http --port 5100
```

- The server is stateless: each `POST /mcp` is bound to the key on that request (`Authorization: Bearer vltx_...` or `x-api-key`), so one process serves many tenants and scales horizontally with no session affinity. `GET /healthz` is the health probe.
- It binds loopback by default. Put it behind a TLS-terminating reverse proxy rather than exposing it directly, and disable response buffering for the `/mcp` location.
- Set `VELTRIX_MCP_ALLOWED_HOSTS` to the public hostname to reject requests with any other `Host` header. If you set `VELTRIX_API_KEY` as a fallback in HTTP mode, the process holds a credential, so `Host` is restricted to localhost unless you set the allowlist.
- On `SIGTERM` / `SIGINT` the server stops accepting connections and lets in-flight calls finish (10 seconds) before exiting.

In the standard Veltrix production deployment this runs as the `veltrix-mcp` PM2 service on loopback `:5100`, proxied by nginx at `https://app.<your-domain>/mcp`.

## Plan requirement

MCP access is included in paid plans and is off on the free tier. The server checks the tenant's entitlement once per session and refuses tool calls with an upgrade message when the plan does not include it.

## Development

```bash
cd mcp
npm install
npm run build
npm test            # unit tests (mocked API)
npm run dev         # stdio against VELTRIX_API_URL
npm run smoke       # live end-to-end against a running Veltrix dev stack
```

`npm run smoke` signs in as the dev user, mints a key, drives the tools over stdio, and asserts that the key cannot approve, reject or force-approve a canvas through the REST API.

Releases publish to npm from a `mcp-v<version>` tag (`.github/workflows/publish-mcp.yml`); the tag must match `package.json`.

## License

MIT
