import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { attachDriftActor, veltrixActorLogins } from '../lib/qualysActivityLog'
import { listAssetGroups, normalizeIps } from './deploy'
import { assetGroupKey, extractAssetGroupSpecs, type LiveAssetGroup } from './validate'

/**
 * Detect drift between the deployed asset group configuration and the live
 * platform. Re-finds each declared group by title and diffs the managed fields
 * (comments, business impact, IP set); a missing group is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAssetGroupSpecs(ctx.deployedConfig).filter((s) => s.title)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAssetGroups(client)
    const byKey = new Map<string, LiveAssetGroup>(live.map((g) => [assetGroupKey(g), g]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(assetGroupKey(spec))
      if (!found) {
        diffs.push({ field: spec.title, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.title, excludeActorLogins })
        continue
      }
      if ((found.comments ?? '') !== spec.comments) {
        diffs.push({
          field: `${spec.title}.comments`,
          expected: spec.comments || 'not set',
          actual: found.comments || 'not set',
          severity: 'info',
        })
      }
      if (spec.businessImpact && found.businessImpact !== spec.businessImpact) {
        diffs.push({
          field: `${spec.title}.business_impact`,
          expected: spec.businessImpact,
          actual: found.businessImpact || 'not set',
          severity: 'warning',
        })
      }
      const declaredIps = normalizeIps(spec.ips)
      if (declaredIps) {
        const liveIps = [...found.ips].sort().join(',')
        const wantIps = declaredIps.split(',').sort().join(',')
        if (liveIps !== wantIps) {
          diffs.push({
            field: `${spec.title}.ips`,
            expected: declaredIps,
            actual: found.ips.join(',') || 'none',
            severity: 'warning',
          })
        }
      }

      // Attribute every diff this group produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id,
        targetName: spec.title,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'qualys',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
