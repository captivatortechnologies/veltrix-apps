import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { attachDriftActor, veltrixActorLogins } from '../../lib/s1ActivityLog'
import { listRestrictions } from './deploy'
import { extractHashSpecs, hashKey } from './validate'

/**
 * Detect drift between the deployed hash allowlist and the live scope. Restrictions
 * have no mutable fields — an entry is present or absent — so drift is presence
 * only: re-find each declared hash by its (SHA1, osType) key; a missing hash is
 * critical drift.
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

    const veltrixLogins = veltrixActorLogins(ctx.credential)
    const attributions: Array<Promise<void>> = []

    for (const spec of specs) {
      const label = `${spec.sha1} (${spec.osType})`
      if (!keys.has(hashKey(spec))) {
        const before = diffs.length
        diffs.push({ field: label, expected: 'allowlisted', actual: 'missing', severity: 'critical' })
        // Best-effort "who removed it + when", correlated by the hash value.
        attributions.push(
          attachDriftActor(client, diffs.slice(before), {
            targetName: spec.sha1,
            excludeActorLogins: veltrixLogins,
          }),
        )
      }
    }
    await Promise.all(attributions)
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
