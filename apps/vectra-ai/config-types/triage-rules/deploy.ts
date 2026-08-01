import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { buildRuleBody, rulesFromList, findRule, type VectraRule } from './_shared'

/**
 * Deploy Vectra triage rules over the Detect REST API (v2.5, 443):
 *   read (rollback): GET    /rules            → find the live rule by description
 *   create:          POST   /rules            with the rule body
 *   update:          PUT    /rules/{id}        with the rule body (rule exists)
 *
 * The rule description is the stable identity used to upsert. rollbackData records,
 * per rule, the prior rule body (null when it did not exist) AND the rule id — so
 * rollback can restore the prior body or delete the one we created.
 *
 * NOTE: Vectra returns the created/updated rule (with its id) from /rules. Some
 * builds wrap it in a `{ rule: {...} }` envelope — both shapes are handled. Verify
 * against a live Vectra brain.
 */
interface RuleMutationResponse extends VectraRule {
  rule?: VectraRule
}

/** Pull the rule id out of a create/update response (bare object or {rule} wrapper). */
function idOf(res: RuleMutationResponse | null): number | string | null {
  return res?.id ?? res?.rule?.id ?? null
}

/** Read every live rule (best-effort) for identity matching + rollback snapshots. */
async function listRules(base: string, headers: Record<string, string>): Promise<VectraRule[]> {
  try {
    return rulesFromList(await getJson<unknown>(`${base}/rules?page_size=5000`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for triage-rule deployment' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ description: string; ruleId: number | string | null; rule: VectraRule | null }> = []
  const applied: string[] = []

  try {
    const live = await listRules(base, headers)

    for (const item of items) {
      const description = String(item.fields.description ?? '').trim()
      if (!description) continue

      const existing = findRule(live, description)
      const body = buildRuleBody(item.fields)

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/rules/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ description, ruleId: existing.id, rule: existing })
      } else {
        const created = await sendJson<RuleMutationResponse>('POST', `${base}/rules`, headers, body)
        previous.push({ description, ruleId: idOf(created), rule: null })
      }
      applied.push(description)
    }

    return {
      success: true,
      message: `Applied ${applied.length} triage rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Triage-rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
