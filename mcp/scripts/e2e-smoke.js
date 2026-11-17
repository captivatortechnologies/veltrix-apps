/**
 * End-to-end smoke against a LIVE Veltrix dev stack:
 *   portal login -> mint role-bound API key -> MCP client over stdio ->
 *   reads -> schema discovery -> draft / validate / comment / version tools ->
 *   submit for approval -> prove the key cannot approve -> cleanup.
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

const failures = [];
function check(label, condition, detail) {
  console.log(`    ${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(label);
}

async function main() {
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

  // Key management keeps browser CSRF: double-submit cookie + header pair.
  const csrf = 'a'.repeat(64);
  const csrfHeaders = { cookie: `XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
  const keyRes = await fetch(`${API}/api/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...csrfHeaders },
    body: JSON.stringify({ name: `mcp-smoke-${Date.now()}`, type: 'api', roleId: jwtPayload.roleId }),
  });
  if (keyRes.status !== 201) throw new Error(`key create failed: ${keyRes.status} ${await keyRes.text()}`);
  const keyData = await keyRes.json();
  const keyHeaders = { 'x-api-key': keyData.key, 'content-type': 'application/json' };
  console.log('[2] API key created:', keyData.id);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, VELTRIX_API_URL: API, VELTRIX_API_KEY: keyData.key },
  });
  const client = new Client({ name: 'smoke-client', version: '0.0.1' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts();
  console.log('[3] MCP connected; tools:', tools.length, 'prompts:', prompts.length);

  async function call(name, args, { allowError = false } = {}) {
    const result = await client.callTool({ name, arguments: args || {} });
    const text = result.content && result.content[0] ? String(result.content[0].text) : '';
    console.log(`  - ${name}: isError=${!!result.isError} :: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    if (result.isError && !allowError) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
    return { result, text, json: () => JSON.parse(text) };
  }

  let canvasId;
  try {
    await call('veltrix_whoami');
    await call('veltrix_pipeline_summary');
    await call('veltrix_list_canvases', { limit: 3 });
    await call('veltrix_list_apps', { enabledOnly: true });
    await call('veltrix_list_environments');
    await call('veltrix_list_drift', { limit: 3 });
    await call('veltrix_compliance_report');
    await call('veltrix_audit_logs');

    console.log('[4] schema discovery');
    await call('veltrix_get_app', { appId: TOOL_TYPE });
    await call('veltrix_get_config_type_schema', { appId: TOOL_TYPE, configTypeId: ENTITY_TYPE });

    console.log('[5] draft -> validate -> review -> versions');
    const created = (
      await call('veltrix_create_canvas', {
        name: `mcp-smoke-canvas-${Date.now()}`,
        toolType: TOOL_TYPE,
        entityType: ENTITY_TYPE,
        description: 'MCP e2e smoke — safe to delete',
      })
    ).json();
    canvasId = created.id;
    console.log('    created canvas', canvasId, 'createdBy:', created.createdBy && created.createdBy.name);
    await call('veltrix_validate_canvas', { canvasId }, { allowError: true });
    await call('veltrix_get_pipeline_status', { canvasId });
    await call('veltrix_add_canvas_comment', { canvasId, body: 'smoke: proposed by the MCP e2e run' });
    const comments = (await call('veltrix_list_canvas_comments', { canvasId })).json();
    check('comment round-trips', Array.isArray(comments) && comments.length === 1);
    await call('veltrix_get_canvas_history', { canvasId });
    await call('veltrix_export_canvas', { canvasId });

    console.log('[6] approval stays human');
    const approvers = (await call('veltrix_list_approvers')).json();
    check('approver list contains people', approvers.length > 0);
    check(
      'approver list hides API-key identities',
      approvers.every((user) => !String(user.email).endsWith('.apikey.system.veltrix.internal')),
    );

    const selfApprove = await call(
      'veltrix_submit_canvas_for_approval',
      { canvasId, approverIds: [created.createdById] },
      { allowError: true },
    );
    check('the key cannot name itself approver', selfApprove.result.isError === true, selfApprove.text.slice(0, 90));

    const human = approvers.find((user) => user.email === EMAIL) || approvers[0];
    const submitted = await call(
      'veltrix_submit_canvas_for_approval',
      { canvasId, approverIds: [human.id], comment: 'smoke: please review' },
      { allowError: true },
    );
    if (submitted.result.isError) {
      console.log('    (submit refused — likely a validation or tier gate; decision checks still run)');
    }

    const approve = await fetch(`${API}/api/configuration-canvas/${canvasId}/approve`, {
      method: 'POST',
      headers: keyHeaders,
      body: JSON.stringify({ comment: 'self-approved by key' }),
    });
    check('REST approve with the key is refused', approve.status === 403, `status ${approve.status}`);

    const reject = await fetch(`${API}/api/configuration-canvas/${canvasId}/reject`, {
      method: 'POST',
      headers: keyHeaders,
      body: JSON.stringify({ reason: 'rejected by key' }),
    });
    check('REST reject with the key is refused', reject.status === 403, `status ${reject.status}`);

    const forceStatus = await fetch(`${API}/api/configuration-canvas/${canvasId}/status`, {
      method: 'PATCH',
      headers: keyHeaders,
      body: JSON.stringify({ status: 'APPROVED' }),
    });
    check('REST status -> APPROVED with the key is refused', forceStatus.status === 403, `status ${forceStatus.status}`);

    const after = (await call('veltrix_get_canvas', { canvasId })).json();
    check('canvas was never approved', after.status !== 'APPROVED', `status ${after.status}`);
  } finally {
    console.log('[7] cleanup');
    if (canvasId) {
      // A canvas pending approval is withdrawn to DRAFT before it can be deleted.
      await fetch(`${API}/api/configuration-canvas/${canvasId}/status`, {
        method: 'PATCH',
        headers: keyHeaders,
        body: JSON.stringify({ status: 'DRAFT' }),
      });
      await call('veltrix_delete_canvas', { canvasId }, { allowError: true });
    }
    await client.close();
    const revoke = await fetch(`${API}/api/api-keys/${keyData.id}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...csrfHeaders },
    });
    console.log('    key revoked:', revoke.status);
  }

  if (failures.length > 0) throw new Error(`${failures.length} check(s) failed: ${failures.join('; ')}`);
  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error);
  process.exit(1);
});
