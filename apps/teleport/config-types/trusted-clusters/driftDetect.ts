import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient } from '../../lib/teleport'
import { normalizeResourceYaml } from '../../lib/resourceYaml'
import { getTrustedCluster } from './deploy'
import { extractTrustedClusterSpecs, buildTrustedClusterYaml } from './validate'

/**
 * Detect drift between the deployed trusted cluster configuration and live
 * Teleport state. Re-reads each declared trusted cluster by name (from the
 * list endpoint — there is no single-item GET) and compares the full
 * resource YAML, normalized so a cosmetic re-serialization does not read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTrustedClusterSpecs(ctx.deployedConfig).filter((s) => s.name && s.spec)

  for (const spec of specs) {
    try {
      const live = await getTrustedCluster(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const expected = normalizeResourceYaml(buildTrustedClusterYaml(spec))
      const actual = normalizeResourceYaml(live.content ?? '')
      if (expected !== actual) {
        diffs.push({ field: `${spec.name}.spec`, expected, actual, severity: 'critical' })
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
