import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_ENTITLEMENT_PATH, VeltrixApiError, VeltrixClient } from '../veltrix-client';
import { READ, runTool, toolRegistrar } from './helpers';

export const KEY_STATUS_PATH = '/api/api-keys/self';
const ORGANIZATION_PATH = '/api/organization';

/** A part of the identity the key may not be allowed to read; never fails whoami. */
async function optional<T>(request: Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof VeltrixApiError) return { unavailable: error.message };
    throw error;
  }
}

export function registerIdentityTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_whoami',
    {
      title: 'Who am I',
      description:
        'Call this first, before any other Veltrix tool, to verify the connection. Confirms the API key is valid and when it expires, and returns the tenant’s organization (when the key’s role can read it) and plan. The platform does not list a key’s permissions: what this session may do is decided by the role bound to the key, and a tool that needs a permission the role lacks returns a 403 saying so.',
      inputSchema: {},
      annotations: READ,
    },
    async () =>
      runTool(async () => {
        const key = await client.get<{ valid?: boolean; expiresAt?: string | null }>(KEY_STATUS_PATH);
        const [organization, plan] = await Promise.all([
          optional(client.get<{ id?: string; name?: string }>(ORGANIZATION_PATH)),
          optional(client.get<{ enabled?: boolean; tier?: string }>(MCP_ENTITLEMENT_PATH)),
        ]);
        return {
          key,
          organization:
            'unavailable' in organization ? organization : { id: organization.id, name: organization.name },
          plan,
        };
      }),
  );
}
