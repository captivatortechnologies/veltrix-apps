import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { parseJsonField, priorServerId, readPriorRollback } from '../../lib/reconcile'
import {
  alertFromEnvelope,
  buildDiscoveryAlertBody,
  type ComplianceFrameworkRef,
  type DiscoveryAlertRollbackData,
  type DiscoveryAlertRollbackEntry,
  type OrcaDiscoveryAlert,
} from './_shared'

/**
 * Deploy Orca discovery-based custom alerts over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   read (update/restore): GET  /api/sonar/rules/{id}
 *   create:                POST /api/sonar/rules            -> { data: { rule_id } }
 *   update:                PUT  /api/sonar/rules/{id}
 *
 * Same base resource and reconciliation shape as Custom Alerts (no documented
 * "list" endpoint, so identity is the rule id this app assigns and persists in
 * rollbackData, recovered by the stable canvas item id first then by name).
 * remediation_text is intentionally NOT applied here — it lives behind a
 * separate API call keyed by the server-computed rule_type; see _shared.ts.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback<OrcaDiscoveryAlert>(ctx)

  const previous: DiscoveryAlertRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const ruleJson = parseJsonField<Record<string, unknown>>(item.fields.ruleJson, 'Discovery query')
      if (!ruleJson.ok) throw new Error(`discovery alert "${name}": ${ruleJson.error}`)

      const rawFrameworks = typeof item.fields.complianceFrameworks === 'string' ? item.fields.complianceFrameworks.trim() : ''
      let complianceFrameworks: ComplianceFrameworkRef[] = []
      if (rawFrameworks) {
        const parsed = parseJsonField<ComplianceFrameworkRef[]>(item.fields.complianceFrameworks, 'Compliance frameworks')
        if (!parsed.ok) throw new Error(`discovery alert "${name}": ${parsed.error}`)
        complianceFrameworks = Array.isArray(parsed.value) ? parsed.value : []
      }

      const body = buildDiscoveryAlertBody(item.fields, ruleJson.value, complianceFrameworks)
      const knownId = priorServerId(previousData.previous, itemId, name)

      const prior = knownId ? await readDiscoveryAlert(client, knownId) : null

      if (knownId && prior) {
        const res = await client.request<unknown>('PUT', `/api/sonar/rules/${encodeURIComponent(knownId)}`, body)
        if (res.error) throw new Error(`update discovery alert "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, serverId: knownId, existed: true, prior })
      } else {
        const res = await client.request<unknown>('POST', '/api/sonar/rules', body)
        if (res.error) throw new Error(`create discovery alert "${name}" failed: ${res.error}`)
        const created = alertFromEnvelope(res.data)
        const newId = created?.rule_id ?? null
        previous.push({ itemId, name, serverId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} discovery alert(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies DiscoveryAlertRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Discovery alert deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies DiscoveryAlertRollbackData,
    }
  }
}

/** GET one discovery alert by id, returning its body or null when gone / unreadable. */
async function readDiscoveryAlert(client: OrcaClient, id: string): Promise<OrcaDiscoveryAlert | null> {
  const res = await client.request<unknown>('GET', `/api/sonar/rules/${encodeURIComponent(id)}`)
  if (res.error) return null
  return alertFromEnvelope(res.data)
}
