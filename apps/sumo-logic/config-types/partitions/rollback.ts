import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import { buildPartitionRestoreBody, type Partition } from './_shared'

/**
 * Undo a partitions deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /partitions/<id> with the prior partition body (restore), or —
 * when the partition was newly created (prior body null) — POST
 * /partitions/<id>/decommission (partitions cannot be deleted, only
 * decommissioned). Applied over the Sumo Logic Management API.
 *
 * API: https://www.sumologic.com/help/docs/api/partition-management/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; partitionId: string | null; partition: Partition | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for partition rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let decommissioned = 0
  let skipped = 0
  try {
    for (const { partitionId, partition } of previous) {
      if (partitionId == null) {
        // A created partition whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (partition) {
        await sendJson('PUT', `${base}/partitions/${encodeURIComponent(partitionId)}`, headers, buildPartitionRestoreBody(partition))
        restored++
      } else {
        await sendJson('POST', `${base}/partitions/${encodeURIComponent(partitionId)}/decommission`, headers)
        decommissioned++
      }
    }
    return {
      success: true,
      message: `Rolled back partitions: ${restored} restored, ${decommissioned} decommissioned${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
