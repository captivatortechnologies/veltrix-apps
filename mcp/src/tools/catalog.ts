import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeltrixClient } from '../veltrix-client';
import { READ, runTool, toolRegistrar, uuid } from './helpers';

const appSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  .describe('App slug, e.g. "splunk-enterprise" (see veltrix_list_apps)');

const listAppsSchema: z.ZodRawShape = {
  enabledOnly: z.boolean().optional().describe('true = only apps enabled for this tenant'),
};

const appSchema: z.ZodRawShape = { appId: appSlug };

const configTypeSchema: z.ZodRawShape = {
  appId: appSlug,
  configTypeId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    .describe('Configuration type id from veltrix_get_app (this is the entityType of a canvas)'),
};

const environmentSchema: z.ZodRawShape = { environmentId: uuid('Environment ID (see veltrix_list_environments)') };

export function registerCatalogTools(server: McpServer, client: VeltrixClient): void {
  const register = toolRegistrar(server);

  register(
    'veltrix_list_apps',
    {
      title: 'List apps',
      description:
        'Lists the security-tool apps available to the tenant (e.g. Splunk Enterprise, Splunk Cloud). Pass enabledOnly=true to see only apps the tenant has enabled — the toolType values accepted by veltrix_create_canvas come from these app slugs.',
      inputSchema: listAppsSchema,
      annotations: READ,
    },
    async ({ enabledOnly }) => runTool(() => client.get(enabledOnly ? '/api/apps/enabled' : '/api/apps')),
  );

  register(
    'veltrix_get_app',
    {
      title: 'Get app details',
      description:
        'Returns one app in detail: version, whether it is enabled for the tenant, and its configuration types (id, name, description). A configuration type id is the entityType of a canvas — call veltrix_get_config_type_schema next to see its fields.',
      inputSchema: appSchema,
      annotations: READ,
    },
    async ({ appId }) => runTool(() => client.get(`/api/apps/${encodeURIComponent(String(appId))}`)),
  );

  register(
    'veltrix_get_config_type_schema',
    {
      title: 'Get configuration type schema',
      description:
        'Returns the authoring schema for one configuration type of an app: the canvas template exactly as the app declares it (its fields with key, label, fieldType, required flag, validation rules and options, grouped the way the app groups them) and the default values. Call this before veltrix_create_canvas so you use real field keys and valid values. To see how those fields are laid out inside a canvas’s sections, look at an existing canvas of the same type with veltrix_get_canvas; veltrix_validate_canvas is the authority on whether a draft is correct.',
      inputSchema: configTypeSchema,
      annotations: READ,
    },
    async ({ appId, configTypeId }) =>
      runTool(async () => {
        const base = `/api/apps/${encodeURIComponent(String(appId))}/config-types/${encodeURIComponent(String(configTypeId))}`;
        const [canvas, defaults] = await Promise.all([client.get(`${base}/canvas`), client.get(`${base}/defaults`)]);
        return { appId, configTypeId, canvas, defaults };
      }),
  );

  register(
    'veltrix_list_environments',
    {
      title: 'List environments',
      description:
        'Lists the tenant’s deployment environments (e.g. development, staging, production) with their IDs and deployment policies. veltrix_deploy_canvas needs an environmentId from this list.',
      inputSchema: {},
      annotations: READ,
    },
    async () => runTool(() => client.get('/api/environments')),
  );

  register(
    'veltrix_get_environment_policy',
    {
      title: 'Get environment deployment policy',
      description:
        'Returns one environment’s deployment policy: whether approval is required, minimum approvers and required approver roles, default strategy, canary steps, health-check timeout, auto-rollback and error-rate threshold, and any environment that must pass first. Read it before proposing a deployment so the plan you describe matches what the pipeline will enforce.',
      inputSchema: environmentSchema,
      annotations: READ,
    },
    async ({ environmentId }) => runTool(() => client.get(`/api/environments/${environmentId}/policy`)),
  );

  register(
    'veltrix_list_components',
    {
      title: 'List components',
      description:
        'Lists the tenant’s managed infrastructure components (tool servers/instances): hostname, ports, the tool they run, and tags. Use to answer "what infrastructure is Veltrix managing?".',
      inputSchema: {},
      annotations: READ,
    },
    async () => runTool(() => client.get('/api/components')),
  );
}
