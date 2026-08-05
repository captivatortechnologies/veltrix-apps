import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, stableStringify } from '../../lib/f5xc'
import { extractMaliciousUserMitigationSpecs, type LiveMaliciousUserMitigationSpec } from './validate'
import { buildMaliciousUserMitigationSpecBody } from './deploy'

const OBJECT_PLURAL = 'malicious_user_mitigations'

/**
 * Detect drift between the deployed mitigation policy configuration and the
 * live F5 XC namespace. Each declared policy is re-fetched by name and its
 * full spec is compared (deterministic key-sorted JSON) against what deploy
 * would send.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractMaliciousUserMitigationSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await client.get<LiveMaliciousUserMitigationSpec>(OBJECT_PLURAL, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const expected = stableStringify(buildMaliciousUserMitigationSpecBody(spec))
      const actual = stableStringify(live.spec ?? {})
      if (expected !== actual) {
        diffs.push({
          field: `${spec.name}.spec`,
          expected: buildMaliciousUserMitigationSpecBody(spec),
          actual: live.spec ?? {},
          severity: 'warning',
        })
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
