import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listSandboxRules } from './deploy'
import { extractSandboxRuleSpecs } from './validate'

/**
 * Detect drift between the deployed sandbox rule configuration and the live
 * tenant. Re-finds each declared rule by name and diffs only the managed
 * scalars — presence, `order` and `state`. A missing rule is critical drift.
 *
 * The full rule_json body (Sandbox action, policy categories, file types, …) is
 * intentionally NOT deep-diffed: ZIA server-normalizes references and expands
 * defaults, so a field-by-field JSON comparison is too noisy to be useful.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSandboxRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listSandboxRules(client)
    const byName = new Map(live.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (typeof found.order === 'number' && found.order !== spec.order) {
        diffs.push({
          field: `${spec.name}.order`,
          expected: spec.order,
          actual: found.order,
          severity: 'info',
        })
      }

      const liveState = typeof found.state === 'string' ? found.state.toUpperCase() : ''
      if (liveState && liveState !== spec.state) {
        diffs.push({
          field: `${spec.name}.state`,
          expected: spec.state,
          actual: liveState,
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'zia',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
