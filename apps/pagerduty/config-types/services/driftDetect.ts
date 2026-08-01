import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractServiceSpecs, findService } from './_shared'
import { listServices } from './deploy'

/**
 * Detect drift between the deployed services configuration and the live PagerDuty
 * account. Re-finds each declared service by its `name`:
 *   - a missing service is CRITICAL drift
 *   - a changed escalation policy (by name) is WARNING drift
 *   - a changed alert_creation mode is WARNING drift
 *   - a changed auto_resolve_timeout / acknowledgement_timeout is INFO drift
 *
 * Only STABLE scalars the operator authored are compared; blank fields are left to
 * PagerDuty and never asserted. Best-effort — an unreadable account raises no
 * false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractServiceSpecs(ctx.deployedConfig).filter((s) => s.name && s.escalationPolicyName)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listServices(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read services, no drift asserted
  }

  for (const spec of specs) {
    const match = findService(live, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const actualPolicy = match.escalation_policy?.summary ?? ''
    if (actualPolicy && actualPolicy.toLowerCase() !== spec.escalationPolicyName.toLowerCase()) {
      diffs.push({
        field: `${spec.name}.escalation_policy`,
        expected: spec.escalationPolicyName,
        actual: actualPolicy,
        severity: 'warning',
      })
    }

    if (spec.alertCreation && match.alert_creation && match.alert_creation !== spec.alertCreation) {
      diffs.push({
        field: `${spec.name}.alert_creation`,
        expected: spec.alertCreation,
        actual: match.alert_creation,
        severity: 'warning',
      })
    }

    for (const [key, expected, actual] of [
      ['auto_resolve_timeout', spec.autoResolveTimeout, match.auto_resolve_timeout],
      ['acknowledgement_timeout', spec.acknowledgementTimeout, match.acknowledgement_timeout],
    ] as const) {
      if (expected != null && Number.isFinite(expected) && typeof actual === 'number' && actual !== expected) {
        diffs.push({ field: `${spec.name}.${key}`, expected, actual, severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
