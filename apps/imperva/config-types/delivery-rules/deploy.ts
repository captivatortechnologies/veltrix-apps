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
import {
  classifyDelivery,
  declaredDeliveryValues,
  findRule,
  readDeliveryFields,
  ruleIdOf,
  rulesFromResponse,
  type IncapRule,
} from './_shared'

/**
 * Deploy Imperva Cloud WAF delivery rules over the SAME v1 IncapRules endpoints
 * ACL Rules uses:
 *   read (identity/rollback): POST /sites/incapRules/list   { site_id }
 *   create:                   POST /sites/incapRules/add     { site_id, name, action, ... }
 *   update:                   POST /sites/incapRules/edit     { rule_id, name, action, ... }
 *
 * The rule NAME is the stable identity, scoped to its Site ID — upserted by name
 * WITHIN a site, exactly like ACL Rules. `rollbackData.previous` records, per
 * rule, the prior body (null when it did not exist) AND its rule_id.
 */

interface PriorEntry {
  siteId: string
  name: string
  ruleId: string | number | null
  prior: { name: string; action: string; filter: string; enabled: boolean; values: Record<string, string> } | null
}

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
      const fields = readDeliveryFields(item.fields)
      const kind = classifyDelivery(fields.action)
      if (!fields.siteId || !fields.name || !kind) continue

      if (!rulesBySite.has(fields.siteId)) {
        rulesBySite.set(fields.siteId, await listRules(client, fields.siteId))
      }
      const existing = findRule(rulesBySite.get(fields.siteId) ?? [], fields.name)
      const existingId = existing ? ruleIdOf(existing) : null
      const params = declaredDeliveryValues(fields)

      if (existing && existingId != null) {
        const res = await client.post(INCAP_RULES_EDIT_PATH, { rule_id: existingId, ...params })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`edit "${fields.name}" (site ${fields.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
        previous.push({
          siteId: fields.siteId,
          name: fields.name,
          ruleId: existingId,
          prior: priorOf(existing, fields.name, fields.action),
        })
      } else {
        const res = await client.post(INCAP_RULES_ADD_PATH, { site_id: fields.siteId, ...params })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`add "${fields.name}" (site ${fields.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
        const createdId = json ? ruleIdOf(json as IncapRule) : null
        previous.push({ siteId: fields.siteId, name: fields.name, ruleId: createdId, prior: null })
      }
      applied.push(`${fields.name} (site ${fields.siteId})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} delivery rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Delivery rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

/** Capture the prior body of an existing rule, for rollback (see ./_shared liveDeliveryValues). */
function priorOf(existing: IncapRule, fallbackName: string, fallbackAction: string) {
  const values: Record<string, string> = {}
  for (const [key, raw] of Object.entries(existing)) {
    if (['rule_id', 'id', 'name', 'action', 'filter', 'enabled'].includes(key)) continue
    if (raw !== undefined && raw !== null) values[key] = String(raw)
  }
  return {
    name: String(existing.name ?? fallbackName),
    action: String(existing.action ?? fallbackAction),
    filter: String(existing.filter ?? ''),
    enabled: existing.enabled === undefined ? true : Boolean(existing.enabled),
    values,
  }
}

export type { PriorEntry }
