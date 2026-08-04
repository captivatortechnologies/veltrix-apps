import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractWebhookSubscriptionSpecs, findWebhookSubscription, parseCustomHeaders, parseEvents } from './_shared'
import { listWebhookSubscriptions } from './deploy'

/**
 * Detect drift between the deployed webhook-subscriptions configuration and the
 * live PagerDuty account. Re-finds each declared subscription by its
 * `description` (this app's identity convention — see _shared.ts):
 *   - a missing subscription is CRITICAL drift
 *   - a changed `active` state is WARNING drift
 *   - a changed delivery `url` is WARNING drift
 *
 * We intentionally do NOT deep-diff `events` or `custom_headers` beyond a
 * length/count comparison (INFO): `events` PagerDuty may reorder or normalize,
 * and `custom_headers` VALUES are redacted on every GET (see _shared.ts), so a
 * structural diff of either would flag constant false drift — the same
 * restraint escalation-policies documents for its own server-normalized rule
 * arrays. Best-effort — an unreadable account raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractWebhookSubscriptionSpecs(ctx.deployedConfig).filter((s) => s.description && s.url && s.filterType)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listWebhookSubscriptions(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read subscriptions, no drift asserted
  }

  for (const spec of specs) {
    const match = findWebhookSubscription(live, spec.description)
    if (!match) {
      diffs.push({ field: spec.description, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (typeof match.active === 'boolean' && match.active !== spec.active) {
      diffs.push({ field: `${spec.description}.active`, expected: spec.active, actual: match.active, severity: 'warning' })
    }

    const actualUrl = match.delivery_method?.url ?? ''
    if (spec.url && actualUrl && actualUrl !== spec.url) {
      diffs.push({ field: `${spec.description}.url`, expected: spec.url, actual: actualUrl, severity: 'warning' })
    }

    const expectedEvents = parseEvents(spec.eventsJson).events
    const actualEventCount = Array.isArray(match.events) ? match.events.length : 0
    if (expectedEvents && expectedEvents.length !== actualEventCount) {
      diffs.push({
        field: `${spec.description}.events`,
        expected: `${expectedEvents.length} event type(s)`,
        actual: `${actualEventCount} event type(s)`,
        severity: 'info',
      })
    }

    const expectedHeaders = parseCustomHeaders(spec.customHeadersJson).headers
    const actualHeaderCount = Array.isArray(match.delivery_method?.custom_headers) ? match.delivery_method!.custom_headers!.length : 0
    const expectedHeaderCount = expectedHeaders?.length ?? 0
    if (expectedHeaderCount !== actualHeaderCount) {
      diffs.push({
        field: `${spec.description}.custom_headers`,
        expected: `${expectedHeaderCount} header(s)`,
        actual: `${actualHeaderCount} header(s)`,
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
