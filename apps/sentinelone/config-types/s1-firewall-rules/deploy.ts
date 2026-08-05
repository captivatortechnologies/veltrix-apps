import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildS1Client,
  MISSING_SCOPE_MESSAGE,
  s1ErrorMessage,
  s1Result,
  type S1Client,
} from '../../lib/s1'
import { extractFirewallRuleSpecs, ruleKey, type FirewallRuleSpec, type LiveFirewallRule } from './validate'

export interface FirewallRuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveFirewallRule
}

/**
 * Deploy SentinelOne Firewall Control rules via the Management API
 * (`/firewall-control`, requires the Control SKU).
 *
 * Identity is the rule `name` at the configured scope: list /firewall-control,
 * match on the (case-insensitive) name, then PUT an existing rule or POST a new
 * one. Scope is carried in the request body's `filter`, and an existing rule's
 * id is carried inside `data` — the same request shape this app already uses
 * for /exclusions, since both are SentinelOne "scoped collection" resources
 * (list supports a `ids` filter, matching this convention).
 *
 * Sources (endpoint existence, filter/field names, SKU requirement):
 *  - Celerium/SentinelOne-PowerShellWrapper `Get-SentinelOneFirewallRules`
 *    (GET /firewall-control; actions/directions/osTypes/statuses enums)
 *  - Postman API Network "Create Firewall Rule" / "Get Firewall Rules" /
 *    "Delete Firewall Rules" (SentinelOne workspace)
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) return { success: false, message: MISSING_SCOPE_MESSAGE }

  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? MISSING_SCOPE_MESSAGE }
  const filter = sf.filter

  const specs = extractFirewallRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FirewallRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listFirewallRules(client)
    const byKey = new Map(existing.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = ruleKey(spec.name)
      const live = byKey.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', '/firewall-control', {
          body: { filter, data: { id: live.id, ...buildData(spec) } },
        })
        if (!res.ok) throw new Error(`Failed to update firewall rule "${label}": ${s1ErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/firewall-control', { body: { filter, data: buildData(spec) } })
        if (!res.ok) throw new Error(`Failed to create firewall rule "${label}": ${s1ErrorMessage(res)}`)
        const created = firstResult(s1Result<LiveFirewallRule | LiveFirewallRule[]>(res))
        if (!created?.id) throw new Error(`Firewall rule "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} firewall rule(s) to ${consoleUrl} (${client.currentScope} scope): ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Firewall rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Firewall Control rules at the configured scope; throws on a non-OK response. */
export async function listFirewallRules(client: S1Client): Promise<LiveFirewallRule[]> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.getAll<LiveFirewallRule>('/firewall-control', sq.query)
  if (!res.ok) {
    throw new Error(`Failed to list firewall rules: ${s1ErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** POST /firewall-control may return the created object or an array; normalize to the first. */
function firstResult(result: LiveFirewallRule | LiveFirewallRule[] | null): LiveFirewallRule | null {
  if (!result) return null
  return Array.isArray(result) ? result[0] ?? null : result
}

function buildData(spec: FirewallRuleSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description ?? '',
    action: spec.action,
    direction: spec.direction,
    osType: spec.osType,
    protocol: spec.protocol ?? '',
    application: spec.application ?? '',
    service: spec.service ?? '',
    status: spec.status,
  }
}
