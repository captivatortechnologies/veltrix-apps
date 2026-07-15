import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { getPolicy } from './deploy'
import { coerceValue, extractPolicySettingSpecs, getNestedPath } from './validate'

/**
 * Detect drift between the enforced agent policy settings and the live scope
 * policy. Re-reads the policy and compares each declared setting's current value
 * to the enforced value.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const pp = client.policyPath()
  if (pp.error || !pp.path) return { hasDrift: false, diffs: [] }
  const path = pp.path

  const specs = extractPolicySettingSpecs(ctx.deployedConfig).filter((s) => s.key && s.rawValue.trim() !== '')
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const policy = await getPolicy(client, path)
    for (const spec of specs) {
      const actual = getNestedPath(policy, spec.key)
      const expected = coerceValue(spec.rawValue, spec.valueType)
      if (actual !== expected) {
        diffs.push({
          field: spec.key,
          expected: String(expected),
          actual: actual === undefined ? 'not set' : String(actual),
          severity: 'warning',
        })
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
