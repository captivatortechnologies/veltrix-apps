import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
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

  try {
    const live = await listGatewayLists(client)
    const byKey = new Map<string, LiveGatewayList>(
      live.filter((l) => l.name).map((l) => [gatewayListKey(l.name as string), l]),
    )

    for (const spec of specs) {
      const label = spec.name
      const found = byKey.get(gatewayListKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
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
