import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { listRestrictions } from './deploy'
import { extractHashSpecs, hashKey } from './validate'

/**
 * Detect drift between the deployed blocklist-hash configuration and the live
 * scope. Restrictions have no mutable managed fields (deploy is ADD/REMOVE only),
 * so drift is presence-only: each declared hash is re-found by its (sha1, osType)
 * key and a missing hash is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasScope) return { hasDrift: false, diffs: [] }

  const specs = extractHashSpecs(ctx.deployedConfig).filter((s) => s.sha1 && s.osType)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listRestrictions(client)
    const keys = new Set(
      live
        .filter((e) => e.value && e.osType)
        .map((e) => hashKey({ sha1: e.value as string, osType: e.osType as string })),
    )

    for (const spec of specs) {
      const label = `${spec.sha1} (${spec.osType})`
      if (!keys.has(hashKey(spec))) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'sentinelone',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
