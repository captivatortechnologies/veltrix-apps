import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged, sendJson } from '../../lib/sumoLogicApi'
import { buildIngestBudgetBody, findIngestBudget, type IngestBudget } from './_shared'

/**
 * Deploy Sumo Logic ingest budgets over the Management API v2 (HTTPS):
 *   read (upsert/rollback): GET  /ingestBudgets            → { data: [...], next } (paged)
 *   create:                 POST /ingestBudgets            with the full definition
 *   update:                 PUT  /ingestBudgets/<id>        with the full definition (id lives in the path) —
 *                            the API documents that ALL properties are required on update.
 *
 * The budget NAME is the stable identity used to upsert. rollbackData records,
 * per budget, the prior full body (null when it did not exist) AND the budget
 * id — so rollback can restore the prior body or delete the one we created.
 *
 * API: https://help.sumologic.com/docs/api/ingest-budget-v2/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for ingest budget deployment' }
  }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; budgetId: string | null; budget: IngestBudget | null }> = []
  const applied: string[] = []

  let live: IngestBudget[] = []
  try {
    live = await listPaged<IngestBudget>(base, 'ingestBudgets', headers)
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findIngestBudget(live, name)
      const body = buildIngestBudgetBody(item.fields)

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/ingestBudgets/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, budgetId: String(existing.id), budget: existing })
      } else {
        const created = await sendJson<IngestBudget>('POST', `${base}/ingestBudgets`, headers, body)
        previous.push({ name, budgetId: created?.id != null ? String(created.id) : null, budget: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} ingest budget(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Ingest budget deploy failed after ${applied.length} budget(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
