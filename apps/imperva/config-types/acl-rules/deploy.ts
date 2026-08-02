import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  INCAP_RULES_ADD_PATH,
  INCAP_RULES_EDIT_PATH,
  INCAP_RULES_LIST_PATH,
  isApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaClient,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'
import { findRule, readRuleFields, ruleIdOf, ruleParams, rulesFromResponse, type IncapRule } from './_shared'

/**
 * Deploy Imperva Cloud WAF ACL rules over the Cloud WAF (Incapsula) API v1:
 *   read (identity/rollback): POST /sites/incapRules/list   { site_id }
 *   create:                   POST /sites/incapRules/add     { site_id, name, action, filter, enabled }
 *   update:                   POST /sites/incapRules/edit     { rule_id, name, action, filter, enabled }
 *
 * The rule NAME is the stable identity, scoped to its Site ID — rules are upserted
 * by name WITHIN a site. `rollbackData.previous` records, per rule, the prior body
 * (null when it did not exist) AND its rule_id — so rollback can restore the prior
 * rule or delete the one we created.
 */

interface PriorEntry {
  siteId: string
  name: string
  ruleId: string | number | null
  /** The rule's prior body, or null when we created it. */
  prior: { name: string; action: string; filter: string; enabled: boolean } | null
}

/** List a site's IncapRules (cached per site_id within one deploy). */
async function listRules(client: ImpervaClient, siteId: string): Promise<IncapRule[]> {
  const res = await client.post(INCAP_RULES_LIST_PATH, { site_id: siteId })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) {
    throw new Error(`list rules for site ${siteId} → HTTP ${res.status}: ${apiMessage(json)}`)
  }
  return rulesFromResponse(json)
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []
  const rulesBySite = new Map<string, IncapRule[]>()

  try {
    for (const item of items) {
      const fields = readRuleFields(item.fields)
      if (!fields.siteId || !fields.name) continue

      if (!rulesBySite.has(fields.siteId)) {
        rulesBySite.set(fields.siteId, await listRules(client, fields.siteId))
      }
      const existing = findRule(rulesBySite.get(fields.siteId) ?? [], fields.name)
      const existingId = existing ? ruleIdOf(existing) : null

      if (existing && existingId != null) {
        const res = await client.post(INCAP_RULES_EDIT_PATH, { rule_id: existingId, ...ruleParams(fields) })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`edit "${fields.name}" (site ${fields.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
        previous.push({
          siteId: fields.siteId,
          name: fields.name,
          ruleId: existingId,
          prior: {
            name: String(existing.name ?? fields.name),
            action: String(existing.action ?? fields.action),
            filter: String(existing.filter ?? ''),
            enabled: existing.enabled === undefined ? true : Boolean(existing.enabled),
          },
        })
      } else {
        const res = await client.post(INCAP_RULES_ADD_PATH, { site_id: fields.siteId, ...ruleParams(fields) })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`add "${fields.name}" (site ${fields.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
        const createdId = json ? ruleIdOf(json as IncapRule) : null
        previous.push({ siteId: fields.siteId, name: fields.name, ruleId: createdId, prior: null })
      }
      applied.push(`${fields.name} (site ${fields.siteId})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} ACL rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `ACL rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
