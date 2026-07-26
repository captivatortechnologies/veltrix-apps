import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { attachDriftActor, veltrixActorLogins } from '../lib/qualysActivityLog'
import { listDynamicLists } from './deploy'
import { dynamicListKey, extractDynamicListSpecs, type LiveDynamicList } from './validate'

/**
 * Detect drift between the deployed dynamic search list configuration and the
 * live platform. Re-finds each declared list by title and diffs the fields the
 * list API exposes in a comparable form (global flag, comments); a missing list
 * is critical drift. (The evaluated criteria are not returned as re-submittable
 * parameters, so they are not diffed here.)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDynamicListSpecs(ctx.deployedConfig).filter((s) => s.title)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listDynamicLists(client)
    const byKey = new Map<string, LiveDynamicList>(live.map((l) => [dynamicListKey(l), l]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(dynamicListKey(spec))
      if (!found) {
        diffs.push({ field: spec.title, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.title, excludeActorLogins })
        continue
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
