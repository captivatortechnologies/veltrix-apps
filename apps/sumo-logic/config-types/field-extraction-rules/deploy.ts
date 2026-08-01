import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildRuleBody, rulesFromList, findRule, type ExtractionRule } from './_shared'

/**
 * Deploy Sumo Logic Field Extraction Rules over the Management API (HTTPS):
 *   read (upsert/rollback): GET    /extractionRules            → { data: [...] }
 *   create:                 POST   /extractionRules            with { name, scope, parseExpression, enabled }
 *   update:                 PUT    /extractionRules/<id>       with the same body (id lives in the path)
 *
 * The rule NAME is the stable identity used to upsert. rollbackData records, per
 * rule, the prior rule body (null when it did not exist) AND the rule id — so
 * rollback can restore the prior body or delete the one we created.
 *
 * API: https://www.sumologic.com/help/docs/api/field-extraction-rules/
 * The POST response returns the created rule including its assigned `id` (verified
 * against sumologic/sumologic_extraction_rule.go). Verify the list envelope
 * (`{ data: [...] }`, pagination) against a live Sumo Logic.
 */
async function listRules(base: string, headers: Record<string, string>): Promise<ExtractionRule[]> {
  try {
    return rulesFromList(await getJson<unknown>(`${base}/extractionRules`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for field extraction rule deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; ruleId: string | null; rule: ExtractionRule | null }> = []
  const applied: string[] = []

  try {
    const live = await listRules(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findRule(live, name)
      const body = buildRuleBody(item.fields)

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/extractionRules/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, ruleId: String(existing.id), rule: existing })
      } else {
        const created = await sendJson<ExtractionRule>('POST', `${base}/extractionRules`, headers, body)
        previous.push({ name, ruleId: created?.id != null ? String(created.id) : null, rule: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} field extraction rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Field extraction rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
