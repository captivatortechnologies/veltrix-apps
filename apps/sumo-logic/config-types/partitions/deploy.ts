import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged, sendJson } from '../../lib/sumoLogicApi'
import { buildPartitionCreateBody, buildPartitionUpdateBody, findPartition, type Partition } from './_shared'

/**
 * Deploy Sumo Logic partitions over the Management API (HTTPS):
 *   read (upsert/rollback): GET  /partitions            → { data: [...], next } (paged)
 *   create:                 POST /partitions            with { name, routingExpression, retentionPeriod?, analyticsTier?, isCompliant? }
 *   update:                 PUT  /partitions/<id>        with the mutable subset (id lives in the path)
 *
 * The partition NAME is the stable identity used to upsert. A partition cannot be
 * renamed or its tier changed, so update only sends the mutable fields. A
 * decommissioned partition (isActive === false) is skipped — Sumo Logic forbids
 * both updating it and reusing its name. rollbackData records, per partition, the
 * prior partition body (null when it did not exist) AND its id — so rollback can
 * restore the prior body or decommission the one we created.
 *
 * API: https://www.sumologic.com/help/docs/api/partition-management/
 * Endpoints verified against the SumoLogic terraform provider
 * (sumologic/sumologic_partition.go). Partitions cannot be deleted — verified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for partition deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; partitionId: string | null; partition: Partition | null }> = []
  const applied: string[] = []
  const skipped: string[] = []

  let live: Partition[] = []
  try {
    live = await listPaged<Partition>(base, 'partitions', headers)
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findPartition(live, name)

      if (existing && existing.isActive === false) {
        skipped.push(name)
        continue
      }

      if (existing && existing.id != null) {
        const body = buildPartitionUpdateBody(item.fields, existing)
        await sendJson('PUT', `${base}/partitions/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, partitionId: String(existing.id), partition: existing })
      } else {
        const body = buildPartitionCreateBody(item.fields)
        const created = await sendJson<Partition>('POST', `${base}/partitions`, headers, body)
        previous.push({ name, partitionId: created?.id != null ? String(created.id) : null, partition: null })
      }
      applied.push(name)
    }

    const skipNote = skipped.length ? ` (skipped ${skipped.length} decommissioned: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} partition(s): ${applied.join(', ') || '(none)'}${skipNote}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Partition deploy failed after ${applied.length} partition(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  }
}
