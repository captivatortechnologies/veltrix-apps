import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { READ, runTool, toolRegistrar } from './helpers';

export function registerReportTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_compliance_report',
    {
      title: 'Compliance report',
      description:
        'Returns the tenant’s compliance report: frameworks, control coverage, and evidence derived from real pipeline activity. Note: Veltrix provides change-governance controls and evidence that support compliance programs; the report is not by itself a legal or regulatory compliance determination.',
      inputSchema: {},
      annotations: READ,
    },
    async () => runTool(() => client.get('/api/reports/compliance')),
  );

  register(
    'veltrix_security_overview',
    {
      title: 'Security overview report',
      description:
        'Returns the tenant’s derived security-posture overview: deployment health, drift posture, approval hygiene, and other governance signals aggregated from real tenant data.',
      inputSchema: {},
      annotations: READ,
    },
    async () => runTool(() => client.get('/api/reports/security-overview')),
  );

  register(
    'veltrix_audit_logs',
    {
      title: 'Audit log report',
      description:
        'Returns the tenant’s unified activity feed: who (person or API key) did what and when across canvases, approvals and deployments. Use it to answer "who changed this?" or to evidence that a change went through approval. Requires the report read permission.',
      inputSchema: {},
      annotations: READ,
    },
    async () => runTool(() => client.get('/api/reports/audit-logs')),
  );
}
