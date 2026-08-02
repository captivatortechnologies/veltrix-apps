import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildRuleBody, rulesFromList, findRule, type GraylogPipelineRule } from './_shared'

/**
 * Deploy Graylog pipeline processing rules over the REST API:
 *   read (rollback): GET  /api/system/pipelines/rule       → find the live rule by title
 *   create:          POST /api/system/pipelines/rule        → RuleSource { id, title, ... }
 *   update:          PUT  /api/system/pipelines/rule/{id}   → RuleSource
 *
 * The rule TITLE (= the DSL rule name, enforced by validate) is the stable identity
 * used to upsert. rollbackData records, per rule, the prior rule (null when it did
 * not exist) AND the rule id — so rollback can restore the prior source or delete
 * the one we created.
 */
interface RuleCreateResponse {
  id?: string
}

async function listRules(base: string, headers: Record<string, string>): Promise<GraylogPipelineRule[]> {
  try {
    return rulesFromList(await getJson<unknown>(`${base}/api/system/pipelines/rule`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for pipeline-rule deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; ruleId: string | null; rule: GraylogPipelineRule | null }> = []
  const applied: string[] = []

  try {
    const live = await listRules(base, headers)

    for (const item of items) {
      const title = asString(item.fields.title)
      if (!title) continue

      const body = buildRuleBody(item.fields)
      const existing = findRule(live, title)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/system/pipelines/rule/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ title, ruleId: existing.id, rule: existing })
      } else {
        const created = await sendJson<RuleCreateResponse>('POST', `${base}/api/system/pipelines/rule`, headers, body)
        previous.push({ title, ruleId: created?.id ?? null, rule: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} pipeline rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Pipeline-rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
