import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { attachDriftActor, veltrixActorLogins } from '../lib/qualysActivityLog'
import { listAuthRecords } from './deploy'
import { extractAuthRecordSpecs, type LiveAuthRecord } from './validate'

/**
 * Detect drift between the deployed authentication records and the live
 * platform. Re-finds each declared record by (type, title) and diffs the only
 * field the list API exposes besides identity (comments); a missing record is
 * critical drift. Credentials are never diffed — Qualys never returns them.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAuthRecordSpecs(ctx.deployedConfig).filter((s) => s.recordType && s.title)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const byType = new Map<string, Map<string, LiveAuthRecord>>()
    for (const recordType of new Set(specs.map((s) => s.recordType))) {
      const live = await listAuthRecords(client, recordType)
      byType.set(recordType, new Map(live.map((r) => [r.title.trim().toLowerCase(), r])))
    }

    for (const spec of specs) {
      const label = `${spec.recordType}:${spec.title}`
      const before = diffs.length
      const found = byType.get(spec.recordType)?.get(spec.title.trim().toLowerCase())
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.title, excludeActorLogins })
        continue
      }
      if ((found.comments ?? '') !== spec.comments) {
        diffs.push({
          field: `${label}.comments`,
          expected: spec.comments || 'not set',
          actual: found.comments || 'not set',
          severity: 'info',
        })
      }

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
