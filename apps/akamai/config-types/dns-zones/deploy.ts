import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson } from '../../lib/akamaiApi'
import { buildZoneBody, readZoneFields, zonePath, type DnsZone } from './_shared'

/**
 * Deploy Akamai Edge DNS zones over the Edge DNS API v2 (EdgeGrid-signed).
 * Unlike Network Lists / Client Lists, the zone NAME is the URL path segment
 * itself, so existence is a direct read rather than a list-then-match:
 *   read (identity/rollback): GET  /config-dns/v2/zones/{zone}
 *   create:                   POST /config-dns/v2/zones?contractId=..&gid=..   { zone, type, ... }
 *   update:                   PUT  /config-dns/v2/zones/{zone}                 { zone, type, ... }
 *
 * `rollbackData.previous` records, per zone, whether it pre-existed and its
 * prior body (null when we created it) — rollback restores the prior body via
 * PUT, or requests deletion of a zone we created (see rollback.ts — zone
 * deletion is an ASYNC bulk operation in this API, so it is best-effort).
 */

interface PriorEntry {
  zone: string
  existed: boolean
  prior: DnsZone | null
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
      const fields = readZoneFields(item.fields)
      if (!fields.zone) continue

      const getRes = await client.request('GET', zonePath(fields.zone))
      const existed = getRes.ok
      const prior = existed ? parseJson<DnsZone>(getRes.body) : null

      if (existed) {
        const res = await client.request('PUT', zonePath(fields.zone), { body: buildZoneBody(fields) })
        if (!res.ok) throw new Error(`PUT zone "${fields.zone}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
      } else {
        const res = await client.request('POST', '/config-dns/v2/zones', {
          query: { contractId: fields.contractId, gid: fields.groupId || undefined },
          body: buildZoneBody(fields),
        })
        if (!res.ok) throw new Error(`POST zone "${fields.zone}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
      }

      previous.push({ zone: fields.zone, existed, prior })
      applied.push(fields.zone)
    }

    return {
      success: true,
      message: `Applied ${applied.length} DNS zone(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `DNS zone deploy failed after ${applied.length} zone(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
