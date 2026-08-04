import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import { buildEdgeWorkerBody, edgeWorkerPath, edgeWorkersFromResponse, edgeWorkersPath, findEdgeWorker, readEdgeWorkerFields, type EdgeWorker } from './_shared'

/**
 * Deploy Akamai EdgeWorker identities over the EdgeWorkers API v1
 * (EdgeGrid-signed), reconciled by NAME:
 *   list:   GET  /edgeworkers/v1/ids                       → find by name
 *   update: PUT  /edgeworkers/v1/ids/{edgeWorkerId}         { name, groupId, resourceTierId }
 *   create: POST /edgeworkers/v1/ids                        { name, groupId, resourceTierId }
 *
 * `rollbackData.previous` records, per EdgeWorker, whether it existed and its
 * prior groupId/resourceTierId (null when we created it) — so rollback can
 * restore the prior placement or delete the one we created.
 *
 * NOTE: this manages IDENTITY only — the code bundle and its activation are
 * out of scope here; see edgeworker-activation for promoting an existing
 * version.
 */

interface PriorEntry {
  name: string
  edgeWorkerId: number | null
  existed: boolean
  prior: { groupId: number; resourceTierId: number } | null
}

async function listAll(client: AkamaiClient): Promise<EdgeWorker[]> {
  const res = await client.request('GET', edgeWorkersPath)
  if (!res.ok) throw new Error(`GET ${edgeWorkersPath} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return edgeWorkersFromResponse(parseJson<unknown>(res.body))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    const live = await listAll(client)

    for (const item of items) {
      const fields = readEdgeWorkerFields(item.fields)
      if (!fields.name) continue

      const existing = findEdgeWorker(live, fields.name)

      if (existing?.edgeWorkerId != null) {
        const res = await client.request('PUT', edgeWorkerPath(existing.edgeWorkerId), { body: buildEdgeWorkerBody(fields) })
        if (!res.ok) throw new Error(`PUT "${fields.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({
          name: fields.name,
          edgeWorkerId: existing.edgeWorkerId,
          existed: true,
          prior: { groupId: existing.groupId ?? 0, resourceTierId: existing.resourceTierId ?? 0 },
        })
      } else {
        const res = await client.request('POST', edgeWorkersPath, { body: buildEdgeWorkerBody(fields) })
        if (!res.ok) throw new Error(`POST "${fields.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        const created = parseJson<EdgeWorker>(res.body)
        previous.push({ name: fields.name, edgeWorkerId: created?.edgeWorkerId ?? null, existed: false, prior: null })
        if (created) live.push(created)
      }
      applied.push(fields.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} EdgeWorker(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `EdgeWorker deploy failed after ${applied.length} of ${items.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
