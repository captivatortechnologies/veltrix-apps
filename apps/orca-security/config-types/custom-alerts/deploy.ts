import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import {
  buildAlertBody,
  alertFromEnvelope,
  priorRuleId,
  type AlertRollbackData,
  type AlertRollbackEntry,
  type OrcaAlert,
} from './_shared'

/**
 * Deploy Orca custom alerts (custom Sonar rules) over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   read (update/restore): GET  /api/sonar/rules/{id}
 *   create:                POST /api/sonar/rules            -> { data: { rule_id } }
 *   update:                PUT  /api/sonar/rules/{id}
 *
 * Orca has no documented "list custom rules" endpoint (its own Terraform
 * provider tracks the returned rule_id in state), so identity is the rule id
 * this app ASSIGNS on create and PERSISTS in rollbackData. The next deploy reads
 * its own prior rollbackData to recover each item's rule id — matching by the
 * stable canvas item id first (so a rename updates the same rule) then by name.
 *
 * rollbackData records, per item, the assigned rule id, whether the rule already
 * existed (so we updated it) and the prior body — enough for rollback to restore
 * or delete. Verify field names / score range against a live Orca tenant.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback(ctx)

  const previous: AlertRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.name ?? '').trim()
      const rule = String(item.fields.rule ?? '').trim()
      if (!name || !rule) continue

      const body = buildAlertBody(item.fields)
      const knownId = priorRuleId(previousData.previous, itemId, name)

      // Confirm the prior rule still exists (and capture its body for restore).
      const prior = knownId ? await readAlert(client, knownId) : null

      if (knownId && prior) {
        const res = await client.request<unknown>('PUT', `/api/sonar/rules/${encodeURIComponent(knownId)}`, body)
        if (res.error) throw new Error(`update alert "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, ruleId: knownId, existed: true, prior })
      } else {
        const res = await client.request<unknown>('POST', '/api/sonar/rules', body)
        if (res.error) throw new Error(`create alert "${name}" failed: ${res.error}`)
        const created = alertFromEnvelope(res.data)
        const newId = created?.rule_id ?? null
        previous.push({ itemId, name, ruleId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom alert(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom alert deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous },
    }
  }
}

/** Read this canvas's own prior rollbackData (the rule ids the last deploy assigned). */
async function readPriorRollback(ctx: DeployContext): Promise<AlertRollbackData> {
  try {
    const latest = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = latest?.rollbackData
    if (data && typeof data === 'object') return data as AlertRollbackData
  } catch {
    // best-effort: no prior data means every item is treated as a create
  }
  return {}
}

/** GET one alert by id, returning its body or null when it is gone / unreadable. */
async function readAlert(client: OrcaClient, id: string): Promise<OrcaAlert | null> {
  const res = await client.request<unknown>('GET', `/api/sonar/rules/${encodeURIComponent(id)}`)
  if (res.error) return null
  return alertFromEnvelope(res.data)
}
