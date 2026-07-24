/**
 * End-to-end smoke against a LIVE Veltrix dev stack:
 *   portal login -> mint role-bound API key -> MCP client over stdio ->
 *   whoami + reads + create/validate/delete canvas -> revoke key.
 *
 * Requires the platform API running (server/) and a seeded dev user.
 * Run from mcp/ after `npm run build`:  npm run smoke
 *
 * Env overrides: VELTRIX_API_URL, VELTRIX_SMOKE_EMAIL, VELTRIX_SMOKE_PASSWORD,
 * VELTRIX_SMOKE_TOOL_TYPE, VELTRIX_SMOKE_ENTITY_TYPE.
 */
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const API = (process.env.VELTRIX_API_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '');
const EMAIL = process.env.VELTRIX_SMOKE_EMAIL || 'dev@local.test';
const PASSWORD = process.env.VELTRIX_SMOKE_PASSWORD || 'DevLocal@123';
const TOOL_TYPE = process.env.VELTRIX_SMOKE_TOOL_TYPE || 'splunk-enterprise';
const ENTITY_TYPE = process.env.VELTRIX_SMOKE_ENTITY_TYPE || 'config-files';
const SERVER_ENTRY = path.join(__dirname, '..', 'dist', 'index.js');

async function main() {
  // 1. Portal login (JWT) — the smoke needs a human session only to mint a key.
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
  const login = await loginRes.json();
  const token = login.token;
  const jwtPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  console.log('[1] logged in as', login.user.email, 'customer', login.user.customerId);

  // 2. Mint a role-bound API key (key management keeps browser CSRF: double-submit pair)
  const csrf = 'a'.repeat(64);
  const csrfHeaders = { cookie: `XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
  const keyRes = await fetch(`${API}/api/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...csrfHeaders },
    body: JSON.stringify({ name: `mcp-smoke-${Date.now()}`, type: 'api', roleId: jwtPayload.roleId }),
  });
  if (keyRes.status !== 201) throw new Error(`key create failed: ${keyRes.status} ${await keyRes.text()}`);
  const keyData = await keyRes.json();
  console.log('[2] API key created:', keyData.id);

  // 3. Real MCP client over stdio against the built server
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, VELTRIX_API_URL: API, VELTRIX_API_KEY: keyData.key },
  });
  const client = new Client({ name: 'smoke-client', version: '0.0.1' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log('[3] MCP connected; tools:', tools.length);

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args || {} });
    const text = result.content && result.content[0] ? String(result.content[0].text) : '';
    console.log(`  - ${name}: isError=${!!result.isError} :: ${text.replace(/\s+/g, ' ').slice(0, 180)}`);
    if (result.isError) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
    return result;
  }

  await call('veltrix_whoami');
  await call('veltrix_pipeline_summary');
  await call('veltrix_list_canvases', { limit: 3 });
  await call('veltrix_list_apps', { enabledOnly: true });
  await call('veltrix_list_environments');
  await call('veltrix_list_drift', { limit: 3 });
  await call('veltrix_compliance_report');

  // 4. Write path: proves per-tenant API-actor attribution (createdById FK)
  const created = await call('veltrix_create_canvas', {
    name: `mcp-smoke-canvas-${Date.now()}`,
    toolType: TOOL_TYPE,
    entityType: ENTITY_TYPE,
    description: 'MCP e2e smoke — safe to delete',
  });
  const canvas = JSON.parse(created.content[0].text);
  console.log('[4] created canvas', canvas.id, 'createdBy:', canvas.createdBy && canvas.createdBy.name);
  await call('veltrix_validate_canvas', { canvasId: canvas.id });
  const del = await fetch(`${API}/api/configuration-canvas/${canvas.id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': keyData.key },
  });
  console.log('    draft canvas deleted:', del.status);

  // 5. Cleanup
  await client.close();
  const revoke = await fetch(`${API}/api/api-keys/${keyData.id}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...csrfHeaders },
  });
  console.log('[5] key revoked:', revoke.status);
  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error);
  process.exit(1);
});
