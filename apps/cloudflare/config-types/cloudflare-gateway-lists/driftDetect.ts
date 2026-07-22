import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { listGatewayLists } from './deploy'
import { extractGatewayListSpecs, gatewayListKey, type LiveGatewayList } from './validate'

/**
 * Detect drift between the deployed Gateway list configuration and the live
 * account. Re-finds each declared list by name and diffs the managed surface
 * (description and entry count); a missing list is critical drift. When no
 * account is resolvable there is nothing to compare against, so report no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  if (!(await client.hasAccount())) {
    return { hasDrift: false, diffs: [] }
  }

  const specs = extractGatewayListSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listGatewayLists(client)
    const byKey = new Map<string, LiveGatewayList>(
      live.filter((l) => l.name).map((l) => [gatewayListKey(l.name as string), l]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byKey.get(gatewayListKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      if ((found.description ?? '') !== spec.description) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description || '(empty)',
          actual: found.description || '(empty)',
          severity: 'info',
        })
      }
      const liveCount = found.count ?? found.items?.length ?? 0
      if (liveCount !== spec.items.length) {
        diffs.push({
          field: `${label}.items`,
          expected: `${spec.items.length} item(s)`,
          actual: `${liveCount} item(s)`,
          severity: 'warning',
        })
      }
      // Attribute every diff this list produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
