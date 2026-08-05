import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTinesClient } from '../../lib/tinesApi'
import { extractGlobalResourceSpecs, findGlobalResource } from './_shared'
import { listGlobalResources } from './deploy'

/**
 * Detect drift between the deployed Global Resources configuration and the
 * live Tines tenant. Re-finds each declared resource by (team, name):
 *   - a missing resource is CRITICAL drift
 *   - a changed value is WARNING drift (values can be large/JSON — no deep diff)
 * Best-effort — an unreadable team raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractGlobalResourceSpecs(ctx.deployedConfig).filter((s) => s.name && s.teamId)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const cache = new Map<string, Awaited<ReturnType<typeof listGlobalResources>>>()
  for (const spec of specs) {
    let live = cache.get(spec.teamId)
    if (!live) {
      try {
        live = await listGlobalResources(client, spec.teamId)
        cache.set(spec.teamId, live)
      } catch {
        continue
      }
    }

    const match = findGlobalResource(live, spec.teamId, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    const liveValue = typeof match.value === 'string' ? match.value : JSON.stringify(match.value)
    if (spec.value && liveValue !== spec.value) {
      diffs.push({ field: `${spec.name}.value`, expected: '(declared value)', actual: '(live value differs)', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
