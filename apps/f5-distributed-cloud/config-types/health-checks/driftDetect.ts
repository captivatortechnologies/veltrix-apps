import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, stableStringify } from '../../lib/f5xc'
import { extractHealthCheckSpecs, type LiveHealthCheckSpec } from './validate'
import { buildHealthCheckSpecBody } from './deploy'

const OBJECT_PLURAL = 'healthchecks'

/**
 * Detect drift between the deployed health check configuration and the live
 * F5 XC namespace. Each declared health check is re-fetched by name and its
 * full spec is compared (deterministic key-sorted JSON) against what deploy
 * would send - any difference (a probe type change, a threshold edited
 * directly in the F5 XC Console, etc.) is reported as one diff per object.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractHealthCheckSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await client.get<LiveHealthCheckSpec>(OBJECT_PLURAL, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const expected = stableStringify(buildHealthCheckSpecBody(spec))
      const actual = stableStringify(live.spec ?? {})
      if (expected !== actual) {
        diffs.push({
          field: `${spec.name}.spec`,
          expected: buildHealthCheckSpecBody(spec),
          actual: live.spec ?? {},
          severity: 'warning',
        })
      }

      const liveDisabled = live.metadata?.disable === true
      if (spec.disable !== liveDisabled) {
        diffs.push({
          field: `${spec.name}.disable`,
          expected: spec.disable,
          actual: liveDisabled,
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
