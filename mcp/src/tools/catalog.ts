import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { runTool, toolRegistrar } from './helpers';

export function registerCatalogTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_list_apps',
    {
      title: 'List apps',
      description:
        'Lists the security-tool apps available to the tenant (e.g. Splunk Enterprise, Splunk Cloud). Pass enabledOnly=true to see only apps the tenant has enabled — the toolType values accepted by veltrix_create_canvas come from these app slugs.',
      inputSchema: {
        enabledOnly: z.boolean().optional().describe('true = only apps enabled for this tenant'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ enabledOnly }) => runTool(() => client.get(enabledOnly ? '/api/apps/enabled' : '/api/apps')),
  );

  register(
    'veltrix_list_environments',
    {
      title: 'List environments',
      description:
        'Lists the tenant’s deployment environments (e.g. development, staging, production) with their IDs and deployment policies. veltrix_deploy_canvas needs an environmentId from this list.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => client.get('/api/environments')),
  );

  register(
    'veltrix_list_components',
    {
      title: 'List components',
      description:
        'Lists the tenant’s managed infrastructure components (tool servers/instances): hostname, ports, the tool they run, and tags. Use to answer "what infrastructure is Veltrix managing?".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => client.get('/api/components')),
  );
}
