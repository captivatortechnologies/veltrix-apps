import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server';

const EXPECTED_TOOLS = [
  'veltrix_whoami',
  'veltrix_list_canvases',
  'veltrix_get_canvas',
  'veltrix_create_canvas',
  'veltrix_update_canvas',
  'veltrix_submit_canvas_for_approval',
  'veltrix_get_canvas_approvals',
  'veltrix_delete_canvas',
  'veltrix_validate_canvas',
  'veltrix_deploy_canvas',
  'veltrix_list_canvas_deployments',
  'veltrix_get_deployment',
  'veltrix_rollback_deployment',
  'veltrix_pipeline_summary',
  'veltrix_environment_matrix',
  'veltrix_list_drift',
  'veltrix_check_canvas_drift',
  'veltrix_get_canvas_drift',
  'veltrix_get_drift_schedule',
  'veltrix_set_drift_schedule',
  'veltrix_clear_drift_schedule',
  'veltrix_compliance_report',
  'veltrix_security_overview',
  'veltrix_list_apps',
  'veltrix_list_environments',
  'veltrix_list_components',
];

describe('buildMcpServer', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: Client;

  beforeEach(async () => {
    fetchMock = jest.fn();
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

  it('registers the full propose-only tool surface (and nothing approval-shaped)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    // Approval decisions must stay human — no approve/reject tools.
    expect(names.some((name) => /approve|reject/.test(name) && !name.includes('approvals') && !name.includes('approval'))).toBe(false);
    expect(names).not.toContain('veltrix_approve_canvas');
    expect(names).not.toContain('veltrix_reject_canvas');
  });

  it('veltrix_whoami forwards the API key and returns the identity payload', async () => {
    const identity = { authenticated: true, customerId: 'cust-1', permissions: ['configuration-canvas:read'] };
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(identity) });

    const result = await client.callTool({ name: 'veltrix_whoami', arguments: {} });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual(identity);
    // First call is the memoized tier-entitlement check; find the whoami call by URL.
    const whoamiCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/auth/api-key/check'));
    expect(whoamiCall).toBeDefined();
    expect(whoamiCall![1].headers['x-api-key']).toBe('vltx_test');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/subscription/mcp-access');
  });

  it('surfaces API failures as isError tool results with the actionable hint', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'missing configuration-canvas:write' }),
    });

    const result = await client.callTool({
      name: 'veltrix_deploy_canvas',
      arguments: { canvasId: '3f8e7d6c-5b4a-4938-a271-605948372615', environmentId: '9a8b7c6d-5e4f-4321-9876-543210fedcba' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('403');
    expect(text).toContain('missing configuration-canvas:write');
    expect(text).toContain('bound role lacks the required permission');
  });

  it('rejects invalid tool arguments before any API call is made', async () => {
    const result = await client.callTool({
      name: 'veltrix_get_canvas',
      arguments: { canvasId: 'not-a-uuid' },
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('list tools carry read-only annotations on read paths', async () => {
    const { tools } = await client.listTools();
    const summary = tools.find((tool) => tool.name === 'veltrix_pipeline_summary');
    expect(summary?.annotations?.readOnlyHint).toBe(true);
    const rollback = tools.find((tool) => tool.name === 'veltrix_rollback_deployment');
    expect(rollback?.annotations?.destructiveHint).toBe(true);
  });
});
