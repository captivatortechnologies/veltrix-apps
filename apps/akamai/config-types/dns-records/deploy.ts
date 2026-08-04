import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson } from '../../lib/akamaiApi'
import { buildRecordBody, readRecordFields, recordPath, type DnsRecord } from './_shared'

/**
 * Deploy Akamai Edge DNS recordsets over the Edge DNS API v2 (EdgeGrid-signed).
 * The (zone, name, type) triple is the URL path itself, so existence is a
 * direct read rather than a list-then-match:
 *   read (identity/rollback): GET    /config-dns/v2/zones/{zone}/names/{name}/types/{type}
 *   create:                   POST   .../names/{name}/types/{type}   { name, type, ttl, rdata }
 *   update (full replace):    PUT    .../names/{name}/types/{type}   { name, type, ttl, rdata }
 *
 * `rollbackData.previous` records, per record, whether it pre-existed and its
 * prior body (null when we created it) — rollback restores the prior body via
 * PUT, or deletes a record we created (a real, synchronous DELETE — unlike
 * zone deletion, per-record deletion is not async).
 */

interface PriorEntry {
  zone: string
  name: string
  recordType: string
  existed: boolean
  prior: DnsRecord | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const fields = readRecordFields(item.fields)
      if (!fields.zone || !fields.name || !fields.recordType) continue

      const path = recordPath(fields.zone, fields.name, fields.recordType)
      const label = `${fields.name} ${fields.recordType} (${fields.zone})`

      const getRes = await client.request('GET', path)
      const existed = getRes.ok
      const prior = existed ? parseJson<DnsRecord>(getRes.body) : null

      const body = buildRecordBody(fields)
      const res = await client.request(existed ? 'PUT' : 'POST', path, { body })
      if (!res.ok) throw new Error(`${existed ? 'PUT' : 'POST'} "${label}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)

      previous.push({ zone: fields.zone, name: fields.name, recordType: fields.recordType, existed, prior })
      applied.push(label)
    }

    return {
      success: true,
      message: `Applied ${applied.length} DNS record(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `DNS record deploy failed after ${applied.length} record(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
