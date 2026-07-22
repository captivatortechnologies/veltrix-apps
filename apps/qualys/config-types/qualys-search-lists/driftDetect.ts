import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { attachDriftActor, veltrixActorLogins } from '../lib/qualysActivityLog'
import { listSearchLists } from './deploy'
import { extractSearchListSpecs, parseQids, searchListKey, type LiveSearchList } from './validate'

/**
 * Detect drift between the deployed static search list configuration and the
 * live platform. Re-finds each declared list by title and diffs the managed
 * fields (QID set, global flag, comments); a missing list is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSearchListSpecs(ctx.deployedConfig).filter((s) => s.title)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listSearchLists(client)
    const byKey = new Map<string, LiveSearchList>(live.map((l) => [searchListKey(l), l]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(searchListKey(spec))
      if (!found) {
        diffs.push({ field: spec.title, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.title, excludeActorLogins })
        continue
      }
      const wantQids = parseQids(spec.qids).slice().sort().join(',')
      const liveQids = found.qids.slice().sort().join(',')
      if (wantQids !== liveQids) {
        diffs.push({
          field: `${spec.title}.qids`,
          expected: parseQids(spec.qids).join(','),
          actual: found.qids.join(',') || 'none',
          severity: 'warning',
        })
      }
      if (found.global !== spec.global) {
        diffs.push({
          field: `${spec.title}.global`,
          expected: String(spec.global),
          actual: String(found.global),
          severity: 'info',
        })
      }
      if ((found.comments ?? '') !== spec.comments) {
        diffs.push({
          field: `${spec.title}.comments`,
          expected: spec.comments || 'not set',
          actual: found.comments || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this list produced to the last human change (once).
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
