import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import { dataFromEnvelope, parseJsonField, priorServerId, readPriorRollback } from '../../lib/reconcile'
import {
  buildAutomationBody,
  findAutomationIdByName,
  readAutomation,
  type AutomationRollbackData,
  type AutomationRollbackEntry,
  type OrcaAutomation,
} from './_shared'

/**
 * Deploy Orca automations over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   read (update/restore): GET  /api/automations/{id}
 *   name fallback (list):  GET  /api/automations?limit=&start_at_index=
 *   create:                POST /api/automations       -> { data: { id } }
 *   update:                PUT  /api/automations/{id}
 *
 * Identity is the automation id this app assigns on create and persists in
 * rollbackData — recovered on the next deploy by the stable canvas item id first
 * (so a rename updates the same automation) then by name. Because automations
 * expose a list endpoint, a first deploy with no rollbackData also falls back to
 * a live name lookup so an automation already present is updated, not duplicated.
 * rollbackData records the assigned id, whether it existed and the prior body.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback<OrcaAutomation>(ctx)

  const previous: AutomationRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const query = parseJsonField(item.fields.sonarQuery, 'Sonar query')
      if (!query.ok) throw new Error(`automation "${name}": ${query.error}`)
      const actions = parseJsonField<unknown[]>(item.fields.actions, 'Actions')
      if (!actions.ok) throw new Error(`automation "${name}": ${actions.error}`)

      const body = buildAutomationBody(item.fields, query.value, Array.isArray(actions.value) ? actions.value : [])

      // Recover the id from our own rollbackData, else a live name lookup.
      const knownId =
        priorServerId(previousData.previous, itemId, name) ?? (await findAutomationIdByName(client, name))

      const prior = knownId ? await readAutomation(client, knownId) : null

      if (knownId && prior) {
        const res = await client.request<unknown>('PUT', `/api/automations/${encodeURIComponent(knownId)}`, body)
        if (res.error) throw new Error(`update automation "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, serverId: knownId, existed: true, prior })
      } else {
        const res = await client.request<unknown>('POST', '/api/automations', body)
        if (res.error) throw new Error(`create automation "${name}" failed: ${res.error}`)
        const created = dataFromEnvelope<OrcaAutomation>(res.data)
        const newId = created?.id ?? null
        previous.push({ itemId, name, serverId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} automation(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies AutomationRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Automation deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies AutomationRollbackData,
    }
  }
}
