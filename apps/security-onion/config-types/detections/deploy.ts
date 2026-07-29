import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSocUrl, buildAuthHeader, soRequest, getJson, sendJson } from '../../lib/soConsole'
import { DETECTION_INDEX, normalizeEnabled } from './_shared'

/**
 * Deploy Kibana Detection Engine rules over the SOC console REST API (443):
 *   read (rollback): GET  /api/detection_engine/rules?rule_id=<id>  (best-effort — 404 = new rule)
 *   create:          POST /api/detection_engine/rules              (upsert by rule_id)
 *   update on 409:   PUT  /api/detection_engine/rules              (rule_id already exists)
 *
 * rollbackData records the prior rule body per rule_id (null when it did not
 * exist) so rollback can PUT it back or DELETE the one we created.
 */
function buildRuleBody(fields: Record<string, unknown>): Record<string, unknown> {
  const name = String(fields.name ?? '').trim()
  const comment = String(fields.comment ?? '').trim()
  return {
    rule_id: String(fields.ruleId ?? '').trim(),
    name,
    type: 'query',
    language: 'kuery',
    query: String(fields.query ?? ''),
    severity: String(fields.severity ?? ''),
    risk_score: Number(fields.riskScore),
    enabled: normalizeEnabled(fields.enabled),
    index: DETECTION_INDEX,
    description: comment || name,
  }
}

/** Read the live rule (best-effort) for the rollback snapshot; null on any miss. */
async function readRule(base: string, headers: Record<string, string>, ruleId: string): Promise<Record<string, unknown> | null> {
  try {
    return await getJson<Record<string, unknown>>(`${base}/api/detection_engine/rules?rule_id=${encodeURIComponent(ruleId)}`, headers)
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for detection rule deployment' }
  }

  const base = buildSocUrl(component, connectivity, connectivityProvider)
  const headers = { ...buildAuthHeader(credential), 'kbn-xsrf': 'true' }

  const previous: Array<{ ruleId: string; rule: Record<string, unknown> | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const ruleId = String(item.fields.ruleId ?? '').trim()
      if (!ruleId) continue

      previous.push({ ruleId, rule: await readRule(base, headers, ruleId) })

      const body = buildRuleBody(item.fields)
      const url = `${base}/api/detection_engine/rules`
      const res = await soRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      if (res.status === 409) {
        await sendJson('PUT', url, headers, body) // rule_id already exists — update in place
      } else if (!res.ok) {
        throw new Error(`POST ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
      }
      applied.push(ruleId)
    }

    return {
      success: true,
      message: `Applied ${applied.length} detection rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Detection rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
