import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listSslRules } from './deploy'
import { extractSslRuleSpecs, parseRuleObject } from './validate'

/**
 * Detect drift between the deployed SSL inspection rule configuration and the
 * live tenant. Re-finds each declared rule by name and diffs the managed
 * fields: presence, `order`, `state` and the SSL action type. A missing rule is
 * critical drift.
 *
 * The rest of the rule_json body is optional, high-cardinality, and ZIA
 * server-normalizes its references (ids, ordering, echoed defaults) — so it is
 * deliberately NOT deep-diffed here; comparing it produces noisy phantom drift.
 *
 * `action.type` is the exception. The action object lives inside rule_json, but
 * its `type` is a single un-normalised scalar and it is what the rule DOES: a
 * rule switched from DECRYPT to DO_NOT_DECRYPT in the console silently stops
 * inspecting TLS for everything it matches, and reporting that as "in sync" is
 * the failure this detector exists to prevent. The rest of the action object is
 * still left alone.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [], checked: false }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractSslRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listSslRules(client)
    const byName = new Map(live.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const before = diffs.length

      // order — the deployed value defaults to 1 the same way deploy does.
      const expectedOrder =
        spec.order !== undefined && Number.isInteger(spec.order) && spec.order > 0 ? spec.order : 1
      if (typeof found.order === 'number' && found.order !== expectedOrder) {
        diffs.push({
          field: `${spec.name}.order`,
          expected: String(expectedOrder),
          actual: String(found.order),
          severity: 'info',
        })
      }

      // state — enabled vs disabled.
      const liveState = typeof found.state === 'string' ? found.state : ''
      if (liveState && liveState !== spec.state) {
        diffs.push({
          field: `${spec.name}.state`,
          expected: spec.state,
          actual: liveState,
          severity: 'warning',
        })
      }

      // action.type — what the rule actually does. Compared only when the canvas
      // declares one; a rule whose rule_json omits the action is not managed
      // here and cannot drift. An action the tenant no longer reports reads as
      // 'not set', because "I could not read it" is not "it matches".
      const declaredAction = declaredActionType(spec.ruleJson)
      if (declaredAction) {
        const liveAction = typeof found.action?.type === 'string' ? found.action.type : ''
        if (liveAction.toUpperCase() !== declaredAction.toUpperCase()) {
          diffs.push({
            field: `${spec.name}.action.type`,
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

/**
 * The SSL action type the canvas declares, or '' when it declares none.
 *
 * rule_json is a raw string here (unlike the sandbox rules, which hand drift a
 * parsed object), and a body that will not parse declares nothing rather than
 * producing a phantom diff — validate already reports that separately.
 */
function declaredActionType(ruleJson: string | undefined): string {
  if (!ruleJson) return ''
  const parsed = parseRuleObject(ruleJson)
  const action = parsed?.action
  if (!action || typeof action !== 'object' || Array.isArray(action)) return ''
  const type = (action as { type?: unknown }).type
  return typeof type === 'string' ? type : ''
}
