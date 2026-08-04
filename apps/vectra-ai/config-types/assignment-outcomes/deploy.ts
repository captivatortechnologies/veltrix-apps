import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { buildOutcomeBody, outcomesFromList, findOutcome, type VectraAssignmentOutcome } from './_shared'

/**
 * Deploy Vectra assignment outcomes over the Detect REST API (v2.5, 443):
 *   read (rollback): GET  /assignment_outcomes        → find the live outcome by title
 *   create:          POST /assignment_outcomes         body { title, category }
 *   update:          PUT  /assignment_outcomes/{id}    body { title, category }
 *
 * The outcome title is the stable identity used to upsert. rollbackData records,
 * per outcome, the prior body (null when it did not exist) AND the outcome id — so
 * rollback can restore the prior body or delete the one we created.
 */
async function listOutcomes(base: string, headers: Record<string, string>): Promise<VectraAssignmentOutcome[]> {
  try {
    return outcomesFromList(await getJson<unknown>(`${base}/assignment_outcomes`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for assignment outcome deployment' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; outcomeId: number | string | null; outcome: VectraAssignmentOutcome | null }> = []
  const applied: string[] = []

  try {
    const live = await listOutcomes(base, headers)

    for (const item of items) {
      const title = String(item.fields.title ?? '').trim()
      if (!title) continue

      const existing = findOutcome(live, title)
      const body = buildOutcomeBody(item.fields)

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/assignment_outcomes/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ title, outcomeId: existing.id, outcome: existing })
      } else {
        const created = await sendJson<VectraAssignmentOutcome>('POST', `${base}/assignment_outcomes`, headers, body)
        previous.push({ title, outcomeId: created?.id ?? null, outcome: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} assignment outcome(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Assignment outcome deploy failed after ${applied.length} outcome(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
