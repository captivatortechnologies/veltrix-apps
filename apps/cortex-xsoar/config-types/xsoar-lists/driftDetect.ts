import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { attachDriftActor, veltrixActorLogins } from '../lib/xsoarAudit'
import { listLists } from './deploy'
import { extractListSpecs, type LiveList } from './validate'

/**
 * Detect drift between the deployed list configuration and the live server.
 * A missing list is critical drift; a changed type or data body is informational
 * drift. Data is compared only when the live listing returns it.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractListSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listLists(client)
    const byName = new Map<string, LiveList>(live.filter((l) => l.name).map((l) => [l.name as string, l]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live object; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      if (typeof found.type === 'string' && found.type !== spec.type) {
        diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: found.type, severity: 'info' })
      }
      if (typeof found.data === 'string' && found.data !== spec.data) {
        diffs.push({ field: `${spec.name}.data`, expected: 'as declared', actual: 'changed on server', severity: 'info' })
      }
      // Attribute every diff this list produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id ?? spec.name,
        targetName: spec.name,
        resource: found,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'cortex-xsoar',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
