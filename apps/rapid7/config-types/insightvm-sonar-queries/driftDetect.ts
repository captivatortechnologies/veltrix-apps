import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listSonarQueries } from './deploy'
import { extractSonarQuerySpecs, sonarQueryKey, type LiveSonarQuery } from './validate'

/**
 * Detect drift between the deployed Sonar queries and the live console.
 * Re-finds each declared query by name; a missing query is critical drift. The
 * criteria filters are not deep-diffed (server-normalized documents).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSonarQuerySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listSonarQueries(client)
    const byKey = new Map<string, LiveSonarQuery>(
      live.filter((q) => q.name).map((q) => [sonarQueryKey({ name: q.name as string }), q]),
    )

    for (const spec of specs) {
      const found = byKey.get(sonarQueryKey(spec))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'insightvm',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
