import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, fetchSiteStatus } from '../../lib/impervaApi'
import { liveSiteConfigValues, READABLE_FIELDS, readSiteConfigFields } from './_shared'

/**
 * Drift for site configuration: compare every READABLE field we declare
 * against the live value on `/sites/status`. Fields with no read-back on this
 * API (domain_validation, approver, ignore_ssl, domain_redirect_to_full) are
 * write-only and cannot be compared — they are simply not checked, rather than
 * raising false drift. Best-effort — a site whose status can't be read is
 * skipped. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const fields = readSiteConfigFields(item.fields)
    if (!fields.siteId) continue

    let live: Record<string, string>
    try {
      live = liveSiteConfigValues(await fetchSiteStatus(client, fields.siteId))
    } catch {
      continue
    }

    const label = `site ${fields.siteId}`
    const declared = fields as unknown as Record<string, string>
    for (const field of READABLE_FIELDS) {
      const expected = declared[field]
      if (!expected) continue // not declared — nothing to compare
      const actual = live[field] ?? ''
      if (expected !== actual) diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
    }
    if (fields.logLevel && live.logLevel !== fields.logLevel) {
      diffs.push({ field: `${label}.logLevel`, expected: fields.logLevel, actual: live.logLevel ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
