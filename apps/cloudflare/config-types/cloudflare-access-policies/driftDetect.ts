import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { listAccessPolicies } from './deploy'
import { extractAccessPolicySpecs, type LiveAccessPolicy } from './validate'

/**
 * Detect drift between the deployed Access policy configuration and the live
 * account. Re-finds each declared policy by name and diffs the decision; a
 * missing policy is critical drift. The include/require/exclude rule arrays are
 * deliberately NOT deep-diffed — they are complex nested structures Cloudflare
 * normalizes on write, so a byte diff would produce noisy false positives.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  if (!(await client.hasAccount())) {
    return { hasDrift: false, diffs: [] }
  }

  const specs = extractAccessPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAccessPolicies(client)
    const byName = new Map<string, LiveAccessPolicy>(live.filter((p) => p.name).map((p) => [p.name as string, p]))

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.decision ?? '') !== spec.decision) {
        diffs.push({
          field: `${label}.decision`,
          expected: spec.decision,
          actual: found.decision ?? 'not set',
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
