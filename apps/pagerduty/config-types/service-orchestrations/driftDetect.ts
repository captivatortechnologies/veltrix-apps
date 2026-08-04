import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractServiceOrchestrationSpecs, findServiceId, parseOrchestrationSets } from './_shared'
import { getServiceOrchestrationActive, getServiceOrchestrationPath, listServices } from './deploy'

/**
 * Detect drift between the deployed service-orchestrations configuration and the
 * live PagerDuty account. Re-resolves each declared service by its `name`:
 *   - a service that no longer resolves is CRITICAL drift
 *   - a changed number of rule sets is INFO drift
 *   - a changed `active` flag is WARNING drift (the orchestration may still exist
 *     but no longer be the service's active processing path, or vice versa)
 *
 * We intentionally do NOT deep-diff the sets/rules/actions JSON (the same
 * restraint event-orchestrations applies to its Router/Global/Unrouted paths —
 * PagerDuty server-assigns rule ids that will never match the compact JSON an
 * operator typed). Best-effort — an unreadable account raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractServiceOrchestrationSpecs(ctx.deployedConfig).filter((s) => s.service && s.setsJson.trim())
  if (specs.length === 0) return { hasDrift: false, diffs }

  let services
  try {
    services = await listServices(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read services, no drift asserted
  }

  for (const spec of specs) {
    const serviceId = findServiceId(services, spec.service)
    if (!serviceId) {
      diffs.push({ field: spec.service, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    try {
      const path = await getServiceOrchestrationPath(client, serviceId, spec.service)
      const expectedSets = parseOrchestrationSets(spec.setsJson).sets
      const actualCount = Array.isArray(path.sets) ? path.sets.length : 0
      if (expectedSets && expectedSets.length !== actualCount) {
        diffs.push({
          field: `${spec.service}.sets`,
          expected: `${expectedSets.length} set(s)`,
          actual: `${actualCount} set(s)`,
          severity: 'info',
        })
      }

      const actualActive = await getServiceOrchestrationActive(client, serviceId, spec.service)
      if (actualActive !== spec.active) {
        diffs.push({ field: `${spec.service}.active`, expected: spec.active, actual: actualActive, severity: 'warning' })
      }
    } catch {
      // best-effort: orchestration state unreadable, no drift asserted for it
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
