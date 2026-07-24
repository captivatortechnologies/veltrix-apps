import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { runTool, toolRegistrar } from './helpers';

export function registerIdentityTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_whoami',
    {
      title: 'Who am I',
      description:
        'Call this first, before any other Veltrix tool, to verify the connection and learn what this session can do. Returns the authenticated tenant (customerId), the API key type, its bound role, and the exact RBAC permissions and scopes granted to this key. If another tool returns a 403, use this to see which permission is missing.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => client.get('/api/auth/api-key/check')),
  );
}
