import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listSandboxRules } from './deploy'
import { extractSandboxRuleSpecs } from './validate'

/**
 * Detect drift between the deployed sandbox rule configuration and the live
 * tenant. Re-finds each declared rule by name and diffs the managed scalars —
 * presence, `order`, `state` and the Sandbox action. A missing rule is critical
 * drift.
 *
 * The REST of the rule_json body (policy categories, file types, advanced
 * criteria, …) is intentionally NOT deep-diffed: ZIA server-normalizes
 * references and expands defaults, so a field-by-field JSON comparison is too
 * noisy to be useful.
 *
 * `ba_rule_action` is the exception. It is one scalar, ZIA does not normalise
 * it, and it is the entire point of a sandbox rule — a rule flipped from BLOCK
 * to ALLOW in the console stops quarantining malware, and reporting that as "in
 * sync" is precisely the failure this detector exists to prevent.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [], checked: false }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

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
      const before = diffs.length

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

      // The Sandbox action, declared inside rule_json. Only compared when the
      // canvas actually claims one — a rule left on the tenant default is not
      // managed here and cannot drift. An action the tenant no longer reports is
      // 'not set' rather than silently skipped, because "I could not read it" is
      // not "it matches".
      const declaredAction = spec.ruleJson?.ba_rule_action
      if (typeof declaredAction === 'string' && declaredAction) {
        const liveAction = typeof found.ba_rule_action === 'string' ? found.ba_rule_action : ''
        if (liveAction.toUpperCase() !== declaredAction.toUpperCase()) {
          diffs.push({
            field: `${spec.name}.ba_rule_action`,
            expected: declaredAction,
            actual: liveAction || 'not set',
            severity: 'critical',
          })
        }
      }

      attachDriftActor(diffs.slice(before), found, { excludeActorLogins })
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
