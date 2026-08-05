import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listForwardingRules } from './deploy'
import { extractForwardingRuleSpecs } from './validate'

/**
 * Detect drift between the deployed forwarding control rule configuration and
 * the live tenant. Re-finds each declared rule by name and diffs only the
 * managed scalar fields: presence, `order`, `type`, `forwardMethod` and
 * `state`. A missing rule is critical drift; a changed forward method is
 * security-relevant (it can silently re-route traffic that was meant to go
 * through ZPA, or vice versa) so it is reported as a warning.
 *
 * The advanced rule_json body (match criteria, zpaGateway/proxyGateway
 * targets) is deliberately NOT deep-diffed: it is optional, high-cardinality,
 * and ZIA server-normalizes references (ids, ordering, echoed defaults), so
 * comparing it produces noisy phantom drift. Presence + the four
 * security-relevant scalars is the signal worth alerting on.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractForwardingRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listForwardingRules(client)
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

      // type — the rule category (FORWARDING vs FIREWALL/DNS/DNAT/…).
      const liveType = typeof found.type === 'string' ? found.type : ''
      if (liveType && liveType !== spec.type) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type,
          actual: liveType,
          severity: 'warning',
        })
      }

      // forwardMethod — a security-relevant change (e.g. DIRECT vs ZPA vs DROP).
      const liveForwardMethod = typeof found.forwardMethod === 'string' ? found.forwardMethod : ''
      if (liveForwardMethod && liveForwardMethod !== spec.forwardMethod) {
        diffs.push({
          field: `${spec.name}.forward_method`,
          expected: spec.forwardMethod,
          actual: liveForwardMethod,
          severity: 'warning',
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
