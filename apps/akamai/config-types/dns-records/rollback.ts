import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient } from '../../lib/akamaiApi'
import { buildRecordBody, readRecordFields, recordPath, type DnsRecord } from './_shared'

/**
 * Undo a DNS Records deploy from rollbackData.previous (written by deploy()):
 *   - a record that PRE-EXISTED → PUT its prior body back.
 *   - a record we CREATED (prior === null) → DELETE it (synchronous — unlike
 *     zone deletion, per-record deletion has no offline/async guard).
 */

interface PriorEntry {
  zone: string
  name: string
  recordType: string
  existed: boolean
  prior: DnsRecord | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0

  try {
    for (const entry of [...previous].reverse()) {
      const path = recordPath(entry.zone, entry.name, entry.recordType)
      const label = `${entry.name} ${entry.recordType} (${entry.zone})`

      if (entry.existed && entry.prior) {
        const priorFields = readRecordFields({ ...entry.prior, zone: entry.zone, recordType: entry.recordType })
        const res = await client.request('PUT', path, { body: buildRecordBody(priorFields) })
        if (!res.ok) throw new Error(`PUT "${label}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        restored++
      } else {
        const res = await client.request('DELETE', path)
        if (!res.ok && res.status !== 404) throw new Error(`DELETE "${label}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        deleted++
      }
    }
    return { success: true, message: `Rolled back DNS records: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
