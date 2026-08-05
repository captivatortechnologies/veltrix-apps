import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTinesClient } from '../../lib/tinesApi'
import { extractTagSpecs, findTag } from './_shared'
import { listTags } from './deploy'

/**
 * Detect drift between the deployed tags configuration and the live Tines
 * tenant. Re-finds each declared tag by (team, name):
 *   - a missing tag is CRITICAL drift
 *   - a changed color is INFO drift
 * Best-effort — an unreadable team raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractTagSpecs(ctx.deployedConfig).filter((s) => s.name && s.teamId)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const cache = new Map<string, Awaited<ReturnType<typeof listTags>>>()
  for (const spec of specs) {
    let live = cache.get(spec.teamId)
    if (!live) {
      try {
        live = await listTags(client, spec.teamId)
        cache.set(spec.teamId, live)
      } catch {
        continue
      }
    }

    const match = findTag(live, spec.teamId, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    if (spec.color && String(match.color ?? '').toLowerCase() !== spec.color.toLowerCase()) {
      diffs.push({ field: `${spec.name}.color`, expected: spec.color, actual: String(match.color ?? ''), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
