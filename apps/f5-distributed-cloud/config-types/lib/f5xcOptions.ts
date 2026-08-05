import type { OptionsProvider, OptionItem } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage } from '../../lib/f5xc'

/**
 * Live options provider for the f5-distributed-cloud config canvas. Powers
 * every cross-object `remote-select` / `remote-multiselect` field (an HTTP
 * Load Balancer's App Firewall / Malicious User Mitigation reference, an
 * Origin Pool's Health Check reference, ...) via
 * GET /api/apps/f5-distributed-cloud/config-options. The platform resolves
 * the connection and runs this in-process, so it can call the tenant's F5 XC
 * namespace directly with the decrypted API Token.
 *
 * F5 XC objects are identified purely by NAME within a namespace (no separate
 * numeric id), so every option's value IS the object's name - which is
 * exactly what a referencing spec's `{ name, namespace }` ref expects.
 */
const OBJECT_PLURAL_BY_SOURCE: Record<string, string> = {
  originPools: 'origin_pools',
  healthChecks: 'healthchecks',
  appFirewalls: 'app_firewalls',
  maliciousUserMitigations: 'malicious_user_mitigations',
  // Irregular plural (see lib/f5xc.ts header comment) - confirmed from F5's
  // generated grpc-gateway route literal, not assumed.
  servicePolicies: 'service_policys',
}

const f5xcOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  const objectPlural = OBJECT_PLURAL_BY_SOURCE[ctx.source]
  if (!objectPlural) return []

  if (!ctx.component?.hostname) {
    throw new Error(
      'No F5 Distributed Cloud deploy target is registered for this connection yet - save the connection first.',
    )
  }

  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) throw new Error(built.error)

  const res = await built.client.list(objectPlural)
  if (!res.ok) {
    throw new Error(
      `Failed to list ${objectPlural} in namespace "${built.namespace}": ${f5xcErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
      })}`,
    )
  }

  const query = (ctx.query ?? '').trim().toLowerCase()
  return res.items
    .filter((item): item is typeof item & { name: string } => Boolean(item.name))
    .filter((item) => !query || item.name.toLowerCase().includes(query))
    .map((item) => ({
      value: item.name,
      label: item.name,
      description: item.description || item.name,
    }))
}

export default f5xcOptions
