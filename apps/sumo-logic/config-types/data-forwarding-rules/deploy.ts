import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged, sendJson } from '../../lib/sumoLogicApi'
import { buildRuleCreateBody, buildRuleUpdateBody, findRuleByIndexId, type DataForwardingRule } from './_shared'

/**
 * Deploy Sumo Logic data forwarding rules over the Management API (HTTPS):
 *   read (upsert/rollback): GET  /logsDataForwarding/rules            → { data: [...], nextToken } (paged)
 *   create:                 POST /logsDataForwarding/rules            with { indexId, destinationId, ... }
 *   update:                 PUT  /logsDataForwarding/rules/<indexId>   with the mutable subset (indexId lives in the path)
 *
 * Unlike every other config type in this app, the identity here (`indexId`) is
 * CALLER-SUPPLIED — the id of an existing Partition or Scheduled View — rather
 * than a name Sumo Logic assigns an id to. rollbackData records, per rule, the
 * prior update-subset body (null when it did not exist) — the indexId itself is
 * always known (it's the identity), so rollback needs no separately-tracked id.
 *
 * API: https://help.sumologic.com/docs/api/data-forwarding/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for data forwarding rule deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ indexId: string; priorBody: Record<string, unknown> | null }> = []
  const applied: string[] = []

  let live: DataForwardingRule[] = []
  try {
    live = await listPaged<DataForwardingRule>(base, 'logsDataForwarding/rules', headers, { nextTokenField: 'nextToken' })
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const indexId = String(item.fields.indexId ?? '').trim()
      if (!indexId) continue

      const existing = findRuleByIndexId(live, indexId)

      if (existing) {
        const priorBody = buildRuleUpdateBody(existing)
        const body = buildRuleUpdateBody(item.fields)
        await sendJson('PUT', `${base}/logsDataForwarding/rules/${encodeURIComponent(indexId)}`, headers, body)
        previous.push({ indexId, priorBody })
      } else {
        const body = buildRuleCreateBody(item.fields)
        await sendJson<DataForwardingRule>('POST', `${base}/logsDataForwarding/rules`, headers, body)
        previous.push({ indexId, priorBody: null })
      }
      applied.push(indexId)
    }

    return {
      success: true,
      message: `Applied ${applied.length} data forwarding rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Data forwarding rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
