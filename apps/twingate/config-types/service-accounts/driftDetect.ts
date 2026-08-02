import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listServiceAccounts } from './deploy'
import { extractServiceAccountSpecs, serviceAccountKey } from './_shared'

/**
 * Detect drift between the deployed Service Account configuration and the
 * live Twingate tenant. Existence-only: `name` is both the identity and the
 * only managed field, so a matched account has nothing further to diff.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractServiceAccountSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listServiceAccounts(client)
    const names = new Set(live.filter((a) => a.name).map((a) => serviceAccountKey(a.name as string)))

    for (const spec of specs) {
      if (!names.has(serviceAccountKey(spec.name))) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'twingate',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
