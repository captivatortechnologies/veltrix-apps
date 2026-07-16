import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
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

  try {
    const live = await listLists(client)
    const byName = new Map<string, LiveList>(live.filter((l) => l.name).map((l) => [l.name as string, l]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (typeof found.type === 'string' && found.type !== spec.type) {
        diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: found.type, severity: 'info' })
      }
      if (typeof found.data === 'string' && found.data !== spec.data) {
        diffs.push({ field: `${spec.name}.data`, expected: 'as declared', actual: 'changed on server', severity: 'info' })
      }
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
