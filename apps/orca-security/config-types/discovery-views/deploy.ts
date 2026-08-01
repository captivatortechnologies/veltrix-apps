import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { dataFromEnvelope, parseJsonField, priorServerId, readPriorRollback } from '../../lib/reconcile'
import {
  buildDiscoveryViewBody,
  type DiscoveryViewRollbackData,
  type DiscoveryViewRollbackEntry,
  type OrcaDiscoveryView,
} from './_shared'

/**
 * Deploy Orca discovery views (user preferences) over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   read (update/restore): GET  /api/user_preferences/{id}
 *   create:                POST /api/user_preferences       -> { data: { preference_id } }
 *   update:                PUT  /api/user_preferences/{id}
 *
 * The API client reads/writes discovery views by preference id, so identity is
 * the id this app assigns on create and persists in rollbackData — recovered on
 * the next deploy by the stable canvas item id first (so a rename updates the
 * same view) then by name. rollbackData records the assigned id, whether the
 * view existed and its prior body — enough for rollback to restore or delete.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback<OrcaDiscoveryView>(ctx)

  const previous: DiscoveryViewRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const query = parseJsonField(item.fields.query, 'Discovery query')
      if (!query.ok) throw new Error(`discovery view "${name}": ${query.error}`)
      const rawExtra = typeof item.fields.extraParams === 'string' ? item.fields.extraParams.trim() : ''
      let extra: unknown = {}
      if (rawExtra) {
        const parsedExtra = parseJsonField(item.fields.extraParams, 'Extra params')
        if (!parsedExtra.ok) throw new Error(`discovery view "${name}": ${parsedExtra.error}`)
        extra = parsedExtra.value
      }

      const body = buildDiscoveryViewBody(item.fields, query.value, extra)
      const knownId = priorServerId(previousData.previous, itemId, name)

      const prior = knownId ? await readDiscoveryView(client, knownId) : null

      if (knownId && prior) {
        const res = await client.request<unknown>('PUT', `/api/user_preferences/${encodeURIComponent(knownId)}`, body)
        if (res.error) throw new Error(`update discovery view "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, serverId: knownId, existed: true, prior })
      } else {
        const res = await client.request<unknown>('POST', '/api/user_preferences', body)
        if (res.error) throw new Error(`create discovery view "${name}" failed: ${res.error}`)
        const created = dataFromEnvelope<OrcaDiscoveryView>(res.data)
        const newId = created?.preference_id ?? null
        previous.push({ itemId, name, serverId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} discovery view(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies DiscoveryViewRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Discovery view deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies DiscoveryViewRollbackData,
    }
  }
}

/** GET one discovery view by id, returning its body or null when gone / unreadable. */
async function readDiscoveryView(client: OrcaClient, id: string): Promise<OrcaDiscoveryView | null> {
  const res = await client.request<unknown>('GET', `/api/user_preferences/${encodeURIComponent(id)}`)
  if (res.error) return null
  return dataFromEnvelope<OrcaDiscoveryView>(res.data)
}
