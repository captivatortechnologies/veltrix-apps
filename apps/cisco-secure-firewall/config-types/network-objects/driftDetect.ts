import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient } from '../../lib/fmc'
import { extractNetworkObjectSpecs, networkObjectDriftDiffs, pathForKind, type NetworkObjectSpec } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractNetworkObjectSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const byKind = new Map<string, NetworkObjectSpec[]>()
  for (const spec of specs) {
    const group = byKind.get(spec.kind) ?? []
    group.push(spec)
    byKind.set(spec.kind, group)
  }

  const diffs: DriftDiff[] = []
  for (const [kind, kindSpecs] of byKind) {
    const listed = await client.list(pathForKind(kind))
    if (!listed.ok) {
      diffs.push({
        field: `network-objects:${kind}`,
        expected: 'reachable',
        actual: `list failed (HTTP ${listed.status})`,
        severity: 'critical',
      })
      continue
    }
    const byName = new Map(listed.items.map((item) => [(item.name ?? '').toLowerCase(), item]))
    for (const spec of kindSpecs) {
      const live = byName.get(spec.name.toLowerCase())
      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      diffs.push(...networkObjectDriftDiffs(spec, live))
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
