import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { NOTIFICATION_RULE_ENDPOINTS, findRule, rulesFromResponse } from './_shared'

/**
 * Drift for alert notification rules: compare forward_type, time_zone and the
 * enabled flag we declare against the live rule in Cortex XDR. `filter` and
 * `forward_source` are not diffed — filter is an opaque criteria object whose
 * live JSON shape is unverified, and forward_source may embed provider ids that
 * are not meaningfully comparable field-by-field without deeper verification.
 * Best-effort — a rule that can't be matched (missing / transient error) is
 * skipped rather than raising false drift. Read-only:
 * GET /platform/notifications/v1/list-rules.
 *
 * VERIFY the list response shape + field names, and the auth requirement (see
 * cortexXdrApi.ts), against a live Cortex XDR tenant.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.request('GET', NOTIFICATION_RULE_ENDPOINTS.list)
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = rulesFromResponse(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findRule(live, name)
    if (!match) continue

    const expectedForwardType = String(item.fields.forward_type ?? '').trim()
    if (expectedForwardType && expectedForwardType !== String(match.forward_type ?? '')) {
      diffs.push({ field: `${name}.forward_type`, expected: expectedForwardType, actual: match.forward_type, severity: 'warning' })
    }

    const expectedTimeZone = String(item.fields.time_zone ?? '').trim() || 'UTC'
    const actualTimeZone = String(match.time_zone ?? '').trim() || 'UTC'
    if (expectedTimeZone !== actualTimeZone) {
      diffs.push({ field: `${name}.time_zone`, expected: expectedTimeZone, actual: actualTimeZone, severity: 'warning' })
    }

    const expectedEnabled = item.fields.enabled !== false && item.fields.enabled !== 'false'
    const actualEnabled = match.enabled !== false
    if (expectedEnabled !== actualEnabled) {
      diffs.push({ field: `${name}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
