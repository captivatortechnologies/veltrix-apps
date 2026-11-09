// Azure resource allow-list for `provider: azure` policies. c7n_azure names
// every resource `azure.<type>`; identity is the ARM resource id (`id`) for
// all of them, location is a property rather than a run dimension, and tags
// are a plain map. The list is the curated subset we have verified against
// the pinned engine image; the canvas keeps the same options (a test checks).

export const AZURE_RESOURCES = [
  'vm',
  'vmss',
  'disk',
  'snapshot',
  'image',
  'storage',
  'storage-container',
  'networksecuritygroup',
  'networkinterface',
  'publicip',
  'vnet',
  'routetable',
  'loadbalancer',
  'dnszone',
  'resourcegroup',
  'keyvault',
  'keyvault-secret',
  'keyvault-key',
  'keyvault-certificate',
  'sql-server',
  'sql-database',
  'mysql-flexibleserver',
  'postgresql-flexibleserver',
  'cosmosdb',
  'redis',
  'webapp',
  'appserviceplan',
  'aks',
  'roleassignment',
  'policyassignments',
] as const

export type AzureResource = (typeof AZURE_RESOURCES)[number]

const RESOURCE_SET: ReadonlySet<string> = new Set(AZURE_RESOURCES)

export const AZURE_PROVIDER_PREFIX = 'azure.'

/** Every Azure resource is identified by its ARM resource id. */
export const AZURE_RESOURCE_ID_KEY = 'id'

export function normalizeAzureResource(resource: string): string {
  const trimmed = resource.trim()
  return trimmed.startsWith(AZURE_PROVIDER_PREFIX) ? trimmed.slice(AZURE_PROVIDER_PREFIX.length) : trimmed
}

export function isAllowedAzureResource(resource: string): boolean {
  return RESOURCE_SET.has(normalizeAzureResource(resource))
}

/**
 * Azure-only action types. `lock` is reversible (a management lock can be
 * removed); `poweroff` deallocates and `stop` only stops billing-wise, both
 * undone by `start`. `delete` and the `delete-*` family stay irreversible via
 * the shared table.
 */
export const AZURE_REVERSIBLE_ACTIONS: readonly string[] = [
  'lock',
  'poweroff',
  'restart',
  'resize',
  'auto-tag-date',
  'modify-disk-type',
]
