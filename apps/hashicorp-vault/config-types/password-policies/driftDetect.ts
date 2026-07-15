import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getPasswordPolicy } from './deploy'
import { extractPasswordPolicySpecs, normalizePasswordPolicy } from './validate'

/**
 * Detect drift between the deployed password policy configuration and live Vault
 * state. Re-reads each declared policy by name and compares the HCL body. The
 * body is NORMALIZED first (whitespace/newlines collapsed) so a cosmetic reflow
 * does not read as drift — only a meaningful change to the policy does.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPasswordPolicySpecs(ctx.deployedConfig).filter((s) => s.name && s.policy)

  for (const spec of specs) {
    try {
      const live = await getPasswordPolicy(client, spec.name)

      if (!live) {
        // A managed policy vanishing is critical — engines referencing it break.
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // The policy body is the whole configuration — normalize both sides so
      // whitespace/newline reformatting does not create phantom drift.
      const expected = normalizePasswordPolicy(spec.policy)
      const actual = normalizePasswordPolicy(typeof live.policy === 'string' ? live.policy : '')
      if (expected !== actual) {
        diffs.push({
          field: `${spec.name}.policy`,
          expected,
          actual,
          severity: 'critical',
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
