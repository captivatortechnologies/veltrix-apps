import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson } from '../../lib/akamaiApi'
import { readRecordFields, recordPath, sameRdata, type DnsRecord } from './_shared'

/**
 * Drift for DNS records: compare the ttl + rdata we declare against the live
 * recordset in Akamai (read directly by zone/name/type — the triple IS the URL
 * identity). Best-effort — a record that can't be read (missing / transient
 * error) is skipped rather than raising false drift. Read-only:
 * GET /config-dns/v2/zones/{zone}/names/{name}/types/{type}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const fields = readRecordFields(item.fields)
    if (!fields.zone || !fields.name || !fields.recordType) continue

    let live: DnsRecord | null
    try {
      const res = await client.request('GET', recordPath(fields.zone, fields.name, fields.recordType))
      if (!res.ok) continue // best-effort: missing/unreadable, no drift asserted
      live = parseJson<DnsRecord>(res.body)
    } catch {
      continue
    }
    if (!live) continue

    const label = `${fields.name} ${fields.recordType} (${fields.zone})`

    if (fields.ttl !== live.ttl) {
      diffs.push({ field: `${label}.ttl`, expected: fields.ttl, actual: live.ttl, severity: 'info' })
    }

    const liveRdata = Array.isArray(live.rdata) ? live.rdata : []
    if (!sameRdata(fields.rdata, liveRdata)) {
      diffs.push({ field: `${label}.rdata`, expected: fields.rdata, actual: liveRdata, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
