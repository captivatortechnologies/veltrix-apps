import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractExtensionSpecs, findExtension, parseExtensionObjects } from './_shared'
import { listExtensions, listServices } from './deploy'

/**
 * Detect drift between the deployed extensions configuration and the live
 * PagerDuty account. Re-finds each declared extension by its `name`:
 *   - a missing extension is CRITICAL drift
 *   - a changed endpoint_url is WARNING drift
 *   - a changed SET of extension_objects (by service name) is WARNING drift
 *
 * We intentionally do NOT deep-diff `config`: it is vendor-specific and its
 * shape is unverified per extension schema (Slack, ServiceNow, a generic
 * webhook, ... each define their own keys), the same restraint cisco-meraki
 * documents for its own unverified per-vendor value shapes. Best-effort — an
 * unreadable account raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractExtensionSpecs(ctx.deployedConfig).filter((s) => s.name && s.extensionSchemaName)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listExtensions(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read extensions, no drift asserted
  }

  // Membership diffs need service names, so map every live service id → name.
  // Best-effort: if this fails, we still report presence + endpoint_url drift.
  let serviceNameById: Map<string, string> | null = null
  try {
    const services = await listServices(client)
    serviceNameById = new Map(services.filter((s) => s.id).map((s) => [String(s.id), String(s.name ?? s.id)]))
  } catch {
    serviceNameById = null
  }

  for (const spec of specs) {
    const match = findExtension(live, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.endpointUrl && match.endpoint_url && match.endpoint_url !== spec.endpointUrl) {
      diffs.push({
        field: `${spec.name}.endpoint_url`,
        expected: spec.endpointUrl,
        actual: match.endpoint_url,
        severity: 'warning',
      })
    }

    if (serviceNameById) {
      const expectedNames = parseExtensionObjects(spec.extensionObjectsJson).names
      if (expectedNames) {
        const expectedSet = new Set(expectedNames.map((n) => n.toLowerCase()))
        const actualNames = (match.extension_objects ?? []).map((o) => (o.id && serviceNameById!.get(o.id)) || o.summary || o.id || '')
        const actualSet = new Set(actualNames.map((n) => n.toLowerCase()))
        const sameMembership =
          expectedSet.size === actualSet.size && [...expectedSet].every((n) => actualSet.has(n))
        if (!sameMembership) {
          diffs.push({
            field: `${spec.name}.extension_objects`,
            expected: [...expectedNames].sort().join(', ') || '(none)',
            actual: [...actualNames].sort().join(', ') || '(none)',
            severity: 'warning',
          })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
