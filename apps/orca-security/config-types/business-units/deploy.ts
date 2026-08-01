import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import {
  dataFromEnvelope,
  priorServerId,
  readPriorRollback,
} from '../../lib/reconcile'
import {
  buildBusinessUnitBody,
  type BusinessUnitRollbackData,
  type BusinessUnitRollbackEntry,
  type OrcaBusinessUnit,
} from './_shared'

/**
 * Deploy Orca business units (filters) over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   read (update/restore): GET  /api/filters/{id}
 *   create:                POST /api/filters        -> { data: { filter_id } }
 *   update:                PUT  /api/filters/{id}
 *
 * Orca has no documented "list filters" endpoint, so identity is the filter id
 * this app ASSIGNS on create and PERSISTS in rollbackData — recovered on the
 * next deploy by the stable canvas item id first (so a rename updates the same
 * unit) then by name. rollbackData records the assigned id, whether the unit
 * already existed and its prior body — enough for rollback to restore or delete.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback<OrcaBusinessUnit>(ctx)

  const previous: BusinessUnitRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const body = buildBusinessUnitBody(item.fields)
      const knownId = priorServerId(previousData.previous, itemId, name)

      // Confirm the prior unit still exists (and capture its body for restore).
      const prior = knownId ? await readBusinessUnit(client, knownId) : null

      if (knownId && prior) {
        const res = await client.request<unknown>('PUT', `/api/filters/${encodeURIComponent(knownId)}`, body)
        if (res.error) throw new Error(`update business unit "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, serverId: knownId, existed: true, prior })
      } else {
        const res = await client.request<unknown>('POST', '/api/filters', body)
        if (res.error) throw new Error(`create business unit "${name}" failed: ${res.error}`)
        const created = dataFromEnvelope<OrcaBusinessUnit>(res.data)
        const newId = created?.filter_id ?? null
        previous.push({ itemId, name, serverId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} business unit(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies BusinessUnitRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Business unit deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies BusinessUnitRollbackData,
    }
  }
}

/** GET one business unit by id, returning its body or null when gone / unreadable. */
async function readBusinessUnit(client: OrcaClient, id: string): Promise<OrcaBusinessUnit | null> {
  const res = await client.request<unknown>('GET', `/api/filters/${encodeURIComponent(id)}`)
  if (res.error) return null
  return dataFromEnvelope<OrcaBusinessUnit>(res.data)
}
