import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson } from '../../lib/akamaiApi'
import { readZoneFields, zonePath, type DnsZone } from './_shared'

/**
 * Drift for DNS zones: compare the type/comment/DNSSEC/masters/target we
 * declare against the live zone in Akamai (read directly by name — the zone
 * name IS the URL identity). Best-effort — a zone that can't be read (missing
 * / transient error) is skipped rather than raising false drift.
 * Read-only: GET /config-dns/v2/zones/{zone}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const fields = readZoneFields(item.fields)
    if (!fields.zone) continue

    let live: DnsZone | null
    try {
      const res = await client.request('GET', zonePath(fields.zone))
      if (!res.ok) continue // best-effort: missing/unreadable, no drift asserted
      live = parseJson<DnsZone>(res.body)
    } catch {
      continue
    }
    if (!live) continue

    const label = fields.zone

    if (fields.type !== String(live.type ?? '').toUpperCase()) {
      diffs.push({ field: `${label}.type`, expected: fields.type, actual: live.type, severity: 'critical' })
    }
    if (fields.comment !== String(live.comment ?? '').trim()) {
      diffs.push({ field: `${label}.comment`, expected: fields.comment, actual: live.comment, severity: 'info' })
    }
    if (fields.signAndServe !== !!live.signAndServe) {
      diffs.push({ field: `${label}.signAndServe`, expected: fields.signAndServe, actual: live.signAndServe, severity: 'warning' })
    }
    if (fields.type === 'SECONDARY') {
      const liveMasters = Array.isArray(live.masters) ? [...live.masters].sort() : []
      const wantMasters = [...fields.masters].sort()
      if (JSON.stringify(liveMasters) !== JSON.stringify(wantMasters)) {
        diffs.push({ field: `${label}.masters`, expected: wantMasters, actual: liveMasters, severity: 'warning' })
      }
    }
    if (fields.type === 'ALIAS' && fields.target !== String(live.target ?? '').trim()) {
      diffs.push({ field: `${label}.target`, expected: fields.target, actual: live.target, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
