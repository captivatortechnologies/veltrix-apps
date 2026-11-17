import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server';

const CANVAS = '3f8e7d6c-5b4a-4938-a271-605948372615';
const OTHER = '9a8b7c6d-5e4f-4321-9876-543210fedcba';
const THIRD = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';

const EXPECTED_TOOLS = [
  'veltrix_whoami',
  'veltrix_list_apps',
  'veltrix_get_app',
  'veltrix_get_config_type_schema',
  'veltrix_list_environments',
  'veltrix_get_environment_policy',
  'veltrix_list_components',
  'veltrix_list_canvases',
  'veltrix_get_canvas',
  'veltrix_create_canvas',
  'veltrix_update_canvas',
  'veltrix_duplicate_canvas',
  'veltrix_export_canvas',
  'veltrix_delete_canvas',
  'veltrix_get_canvas_history',
  'veltrix_get_canvas_version',
  'veltrix_compare_canvas_versions',
  'veltrix_restore_canvas_version',
  'veltrix_list_approvers',
  'veltrix_submit_canvas_for_approval',
  'veltrix_get_canvas_approvals',
  'veltrix_list_canvas_comments',
  'veltrix_add_canvas_comment',
  'veltrix_validate_canvas',
  'veltrix_get_pipeline_status',
  'veltrix_deploy_canvas',
  'veltrix_list_canvas_deployments',
  'veltrix_get_deployment',
  'veltrix_pause_deployment',
  'veltrix_resume_deployment',
  'veltrix_promote_deployment',
  'veltrix_rollback_deployment',
  'veltrix_pipeline_summary',
  'veltrix_environment_matrix',
  'veltrix_list_drift',
  'veltrix_get_canvas_drift',
  'veltrix_check_canvas_drift',
  'veltrix_detect_drift',
  'veltrix_resolve_drift',
  'veltrix_get_drift_schedule',
  'veltrix_set_drift_schedule',
  'veltrix_clear_drift_schedule',
  'veltrix_compliance_report',
  'veltrix_security_overview',
  'veltrix_audit_logs',
];

// Capabilities that must never be reachable through this server.
const FORBIDDEN_TOOL_PATTERN =
  /approve|reject|set_status|credential|secret|api_key|create_user|delete_user|role|install|enable_app|disable_app/;
const ALLOWED_DESPITE_PATTERN = new Set(['veltrix_list_approvers']);

interface RouteCase {
  tool: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

const ROUTES: RouteCase[] = [
  { tool: 'veltrix_get_app', args: { appId: 'splunk-enterprise' }, method: 'GET', path: '/api/apps/splunk-enterprise' },
  { tool: 'veltrix_get_environment_policy', args: { environmentId: OTHER }, method: 'GET', path: `/api/environments/${OTHER}/policy` },
  { tool: 'veltrix_duplicate_canvas', args: { canvasId: CANVAS, name: 'copy' }, method: 'POST', path: `/api/configuration-canvas/${CANVAS}/duplicate`, body: { name: 'copy' } },
  { tool: 'veltrix_export_canvas', args: { canvasId: CANVAS }, method: 'GET', path: `/api/configuration-canvas/${CANVAS}/export` },
  { tool: 'veltrix_get_canvas_history', args: { canvasId: CANVAS, limit: 5 }, method: 'GET', path: `/api/configuration-canvas/${CANVAS}/history`, query: { limit: '5' } },
  { tool: 'veltrix_get_canvas_version', args: { canvasId: CANVAS, historyId: OTHER }, method: 'GET', path: `/api/configuration-canvas/${CANVAS}/versions/${OTHER}` },
  { tool: 'veltrix_compare_canvas_versions', args: { canvasId: CANVAS, historyId1: OTHER, historyId2: THIRD }, method: 'GET', path: `/api/configuration-canvas/${CANVAS}/compare`, query: { historyId1: OTHER, historyId2: THIRD } },
  { tool: 'veltrix_restore_canvas_version', args: { canvasId: CANVAS, historyId: OTHER }, method: 'POST', path: `/api/configuration-canvas/${CANVAS}/versions/${OTHER}/restore` },
  { tool: 'veltrix_submit_canvas_for_approval', args: { canvasId: CANVAS, approverIds: [OTHER], comment: 'why' }, method: 'POST', path: `/api/configuration-canvas/${CANVAS}/submit-for-approval`, body: { approverIds: [OTHER], comment: 'why' } },
  { tool: 'veltrix_list_canvas_comments', args: { canvasId: CANVAS }, method: 'GET', path: `/api/configuration-canvas/${CANVAS}/comments` },
  { tool: 'veltrix_add_canvas_comment', args: { canvasId: CANVAS, body: 'done', parentId: OTHER }, method: 'POST', path: `/api/configuration-canvas/${CANVAS}/comments`, body: { body: 'done', parentId: OTHER } },
  { tool: 'veltrix_get_pipeline_status', args: { canvasId: CANVAS }, method: 'GET', path: `/api/pipeline/canvas/${CANVAS}/pipeline-status` },
  { tool: 'veltrix_pause_deployment', args: { deploymentId: OTHER }, method: 'POST', path: `/api/pipeline/deployments/${OTHER}/pause` },
  { tool: 'veltrix_resume_deployment', args: { deploymentId: OTHER }, method: 'POST', path: `/api/pipeline/deployments/${OTHER}/resume` },
  { tool: 'veltrix_promote_deployment', args: { deploymentId: OTHER, targetEnvironmentId: THIRD }, method: 'POST', path: `/api/pipeline/deployments/${OTHER}/promote`, body: { targetEnvironmentId: THIRD } },
  { tool: 'veltrix_rollback_deployment', args: { deploymentId: OTHER, reason: 'unhealthy' }, method: 'POST', path: `/api/pipeline/deployments/${OTHER}/rollback`, body: { reason: 'unhealthy' } },
  { tool: 'veltrix_detect_drift', args: { environmentId: OTHER }, method: 'POST', path: '/api/pipeline/drift/detect', body: { environmentId: OTHER } },
  { tool: 'veltrix_resolve_drift', args: { driftId: OTHER, action: 'verified' }, method: 'POST', path: `/api/pipeline/drift/${OTHER}/resolve`, body: { action: 'verified' } },
  { tool: 'veltrix_clear_drift_schedule', args: { appId: 'splunk-enterprise' }, method: 'DELETE', path: '/api/pipeline/drift/schedule/splunk-enterprise' },
  { tool: 'veltrix_audit_logs', args: {}, method: 'GET', path: '/api/reports/audit-logs' },
];

type TextContent = Array<{ type: string; text: string }>;

describe('buildMcpServer', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: Client;

  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });

  /** Calls made to the API, excluding the memoized tier-entitlement probe. */
  const apiCalls = () =>
    fetchMock.mock.calls
      .map(([url, init]) => ({ url: new URL(String(url)), init }))
      .filter(({ url }) => url.pathname !== '/api/subscription/mcp-access');

  const textOf = (result: unknown) => ((result as { content: TextContent }).content[0]?.text ?? '');

  beforeEach(async () => {
    fetchMock = jest.fn().mockResolvedValue(respond(200, { ok: true }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const server = buildMcpServer({ apiUrl: 'http://localhost:5000', apiKey: 'vltx_test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  describe('tool surface', () => {
    it('registers exactly the expected tools', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    });

    it('exposes no approval-decision, credential, user-management or app-install tool', async () => {
      const { tools } = await client.listTools();
      const offenders = tools
        .map((tool) => tool.name)
        .filter((name) => FORBIDDEN_TOOL_PATTERN.test(name) && !ALLOWED_DESPITE_PATTERN.has(name));
      expect(offenders).toEqual([]);
    });

    it('gives every tool a title, a description and complete safety annotations', async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.title).toBeTruthy();
        expect((tool.description ?? '').length).toBeGreaterThan(20);
        expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
        expect(typeof tool.annotations?.openWorldHint).toBe('boolean');
        if (tool.annotations?.readOnlyHint === false) {
          expect(typeof tool.annotations.destructiveHint).toBe('boolean');
          expect(typeof tool.annotations.idempotentHint).toBe('boolean');
        }
      }
    });

    it('marks reads read-only, destructive tools destructive, and tool-reaching calls open-world', async () => {
      const { tools } = await client.listTools();
      const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;

      expect(annotations('veltrix_pipeline_summary')?.readOnlyHint).toBe(true);
      expect(annotations('veltrix_list_approvers')?.readOnlyHint).toBe(true);
      expect(annotations('veltrix_create_canvas')?.readOnlyHint).toBe(false);
      expect(annotations('veltrix_create_canvas')?.destructiveHint).toBe(false);
      expect(annotations('veltrix_delete_canvas')?.destructiveHint).toBe(true);
      expect(annotations('veltrix_rollback_deployment')?.destructiveHint).toBe(true);
      expect(annotations('veltrix_deploy_canvas')?.openWorldHint).toBe(true);
      expect(annotations('veltrix_update_canvas')?.openWorldHint).toBe(false);
    });
  });

  describe('request mapping', () => {
    it.each(ROUTES)('$tool -> $method $path', async ({ tool, args, method, path, query, body }) => {
      const result = await client.callTool({ name: tool, arguments: args });
      expect(result.isError).toBeFalsy();

      const calls = apiCalls();
      expect(calls).toHaveLength(1);
      const [{ url, init }] = calls;
      expect(init.method).toBe(method);
      expect(url.pathname).toBe(path);
      expect(Object.fromEntries(url.searchParams)).toEqual(query ?? {});
      expect(init.body === undefined ? undefined : JSON.parse(init.body)).toEqual(body);
      expect(init.headers['x-api-key']).toBe('vltx_test');
    });

    it('veltrix_get_config_type_schema returns the canvas template and defaults together', async () => {
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname.endsWith('/canvas')) return respond(200, { sections: [{ name: 'Inputs', fields: [] }] });
        if (url.pathname.endsWith('/defaults')) return respond(200, { index: 'main' });
        return respond(200, { enabled: true });
      });

      const result = await client.callTool({
        name: 'veltrix_get_config_type_schema',
        arguments: { appId: 'splunk-enterprise', configTypeId: 'config-files' },
      });

      expect(JSON.parse(textOf(result))).toEqual({
        appId: 'splunk-enterprise',
        configTypeId: 'config-files',
        canvas: { sections: [{ name: 'Inputs', fields: [] }] },
        defaults: { index: 'main' },
      });
      expect(apiCalls().map(({ url }) => url.pathname).sort()).toEqual([
        '/api/apps/splunk-enterprise/config-types/config-files/canvas',
        '/api/apps/splunk-enterprise/config-types/config-files/defaults',
      ]);
    });

    it('veltrix_list_approvers returns only the fields needed to pick an approver', async () => {
      fetchMock.mockImplementation(async (url: URL) =>
        url.pathname === '/api/users'
          ? respond(200, [
              { id: OTHER, name: 'Alice', email: 'alice@example.com', role: 'Admin', phoneNumber: '555', customerId: 'c1' },
            ])
          : respond(200, { enabled: true }),
      );

      const result = await client.callTool({ name: 'veltrix_list_approvers', arguments: {} });

      expect(JSON.parse(textOf(result))).toEqual([
        { id: OTHER, name: 'Alice', email: 'alice@example.com', role: 'Admin' },
      ]);
    });

    it('veltrix_whoami forwards the API key after the entitlement probe', async () => {
      const identity = { authenticated: true, customerId: 'cust-1', permissions: ['configuration-canvas:read'] };
      fetchMock.mockResolvedValue(respond(200, identity));

      const result = await client.callTool({ name: 'veltrix_whoami', arguments: {} });

      expect(JSON.parse(textOf(result))).toEqual(identity);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/api/subscription/mcp-access');
      expect(apiCalls()[0].url.pathname).toBe('/api/auth/api-key/check');
    });
  });

  describe('failure handling', () => {
    it('surfaces API failures as isError tool results with the actionable hint', async () => {
      fetchMock.mockResolvedValue(respond(403, { error: 'missing configuration-canvas:write' }));

      const result = await client.callTool({
        name: 'veltrix_deploy_canvas',
        arguments: { canvasId: CANVAS, environmentId: OTHER },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('403');
      expect(textOf(result)).toContain('missing configuration-canvas:write');
      expect(textOf(result)).toContain('bound role lacks the required permission');
    });

    it.each([
      ['veltrix_get_canvas', { canvasId: 'not-a-uuid' }],
      ['veltrix_get_app', { appId: '../../etc/passwd' }],
      ['veltrix_get_config_type_schema', { appId: 'splunk-enterprise', configTypeId: '../canvas' }],
      ['veltrix_resolve_drift', { driftId: OTHER, action: 'ignored' }],
      ['veltrix_submit_canvas_for_approval', { canvasId: CANVAS, approverIds: [] }],
    ])('rejects invalid arguments for %s before any API call', async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('truncates an oversized response with a notice telling the assistant how to narrow it', async () => {
      fetchMock.mockResolvedValue(respond(200, { rows: 'x'.repeat(200_000) }));

      const result = await client.callTool({ name: 'veltrix_environment_matrix', arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toMatch(/^\[Truncated: the response was \d+ characters/);
      expect(textOf(result).length).toBeLessThan(61_000);
    });
  });

  describe('prompts', () => {
    it('registers the workflow prompts', async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
        'veltrix_deployment_report',
        'veltrix_propose_change',
        'veltrix_triage_drift',
      ]);
    });

    it('the propose-change prompt keeps approval with humans', async () => {
      const prompt = await client.getPrompt({
        name: 'veltrix_propose_change',
        arguments: { change: 'forward firewall logs to the security index', app: 'splunk-enterprise' },
      });
      const text = (prompt.messages[0].content as { text: string }).text;

      expect(text).toContain('forward firewall logs to the security index');
      expect(text).toContain('splunk-enterprise');
      expect(text).toContain('veltrix_get_config_type_schema');
      expect(text).toMatch(/Approval is a human decision/);
    });

    it('the drift-triage prompt is read-only until the user chooses', async () => {
      const prompt = await client.getPrompt({ name: 'veltrix_triage_drift', arguments: { environment: 'production' } });
      const text = (prompt.messages[0].content as { text: string }).text;

      expect(text).toContain('production');
      expect(text).toMatch(/Do not resolve, acknowledge, redeploy or edit anything until I choose/);
    });
  });
});
