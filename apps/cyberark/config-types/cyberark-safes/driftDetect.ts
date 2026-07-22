import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { attachDriftActor, veltrixActorLogins } from '../lib/cyberarkAudit'
import { listSafes } from './deploy'
import { extractSafeSpecs, safeKey, type LiveSafe } from './validate'

/**
 * Detect drift between the deployed safe configuration and the live PVWA. Re-finds
 * each declared safe by name and diffs the managed fields (description, retention,
 * autoPurge); a missing safe is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSafeSpecs(ctx.deployedConfig).filter((s) => s.safeName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listSafes(client)
    const byKey = new Map<string, LiveSafe>(
      live.filter((s) => s.safeName).map((s) => [safeKey({ safeName: s.safeName as string }), s]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(safeKey(spec))
      if (!found) {
        diffs.push({ field: spec.safeName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.description ?? '') !== spec.description) {
        diffs.push({ field: `${spec.safeName}.description`, expected: spec.description || '(empty)', actual: found.description ?? 'not set', severity: 'info' })
      }
      const liveRetention =
        spec.retentionType === 'days' ? found.numberOfDaysRetention : found.numberOfVersionsRetention
      if (spec.retentionCount !== null && liveRetention !== spec.retentionCount) {
        diffs.push({
          field: `${spec.safeName}.retention_${spec.retentionType}`,
          expected: spec.retentionCount,
          actual: liveRetention ?? 'not set',
          severity: 'warning',
        })
      }
      if ((found.autoPurgeEnabled ?? false) !== spec.autoPurgeEnabled) {
        diffs.push({ field: `${spec.safeName}.auto_purge`, expected: spec.autoPurgeEnabled, actual: found.autoPurgeEnabled ?? false, severity: 'info' })
      }

      // Attribute every diff this safe produced to its creator (once), read from
      // the live safe already fetched — no-op when nothing drifted or it was ours.
      await attachDriftActor(client, diffs.slice(before), { resource: found, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}
