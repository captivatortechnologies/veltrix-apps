import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, DNS_ZONE_DELETE_REQUESTS_PATH } from '../../lib/akamaiApi'
import { buildZoneBodyFromPrior, zonePath, type DnsZone } from './_shared'

/**
 * Undo a DNS Zones deploy from rollbackData.previous (written by deploy()):
 *   - a zone that PRE-EXISTED → PUT its prior body back (stripped of computed
 *     fields — see _shared.ts buildZoneBodyFromPrior).
 *   - a zone we CREATED (prior === null) → request deletion via the ASYNC bulk
 *     endpoint (POST /config-dns/v2/zones/delete-requests, body: [zone]).
 *     Edge DNS has no synchronous single-zone DELETE: this queues an offline
 *     task and Akamai refuses it outright if the zone is still receiving DNS
 *     queries or is delegated, so this is reported as REQUESTED, not confirmed.
 */

interface PriorEntry {
  zone: string
  existed: boolean
  prior: DnsZone | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  const deleteRequested: string[] = []

  try {
    for (const entry of previous) {
      if (entry.existed && entry.prior) {
        const res = await client.request('PUT', zonePath(entry.zone), { body: buildZoneBodyFromPrior(entry.prior) })
        if (!res.ok) throw new Error(`PUT zone "${entry.zone}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        restored++
      } else {
        deleteRequested.push(entry.zone)
      }
    }

    if (deleteRequested.length > 0) {
      const res = await client.request('POST', DNS_ZONE_DELETE_REQUESTS_PATH, { body: deleteRequested })
      if (!res.ok) {
        throw new Error(
          `Bulk zone delete request for [${deleteRequested.join(', ')}] → HTTP ${res.status}: ${res.body.slice(0, 200)}`,
        )
      }
    }

    const parts = [`${restored} zone(s) restored`]
    if (deleteRequested.length) parts.push(`${deleteRequested.length} deletion(s) requested (async — Akamai processes this offline)`)
    return { success: true, message: `Rolled back DNS zones: ${parts.join(', ')}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
