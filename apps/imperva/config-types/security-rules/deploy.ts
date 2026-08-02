import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  fetchSiteStatus,
  SECURITY_CONFIGURE_PATH,
  isApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaClient,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'
import {
  classifyRule,
  declaredSecurityValues,
  findWafRule,
  liveSecurityValues,
  readSecurityFields,
  wafRulesFromStatus,
  type SecurityKind,
  type WafRuleStatus,
} from './_shared'

/**
 * Deploy Imperva Cloud WAF security rules over the Cloud WAF (Incapsula) API v1.
 * Each rule id is a SINGLETON per site, SET declaratively:
 *   read prior (rollback):   POST /sites/status             { site_id }
 *   set:                     POST /sites/configure/security { site_id, rule_id, ... }
 *
 * `rollbackData.previous` records, per (site, rule), the prior parameter values
 * read from the site status BEFORE the change — so rollback can re-apply them.
 */

interface PriorEntry {
  siteId: string
  ruleId: string
  kind: SecurityKind
  /** Prior parameter values (API param names → values) read from /sites/status. */
  prior: Record<string, string>
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []
  const rulesBySite = new Map<string, WafRuleStatus[]>()

  const loadRules = async (siteId: string): Promise<WafRuleStatus[]> => {
    if (!rulesBySite.has(siteId)) {
      rulesBySite.set(siteId, wafRulesFromStatus(await fetchSiteStatus(client, siteId)))
    }
    return rulesBySite.get(siteId) ?? []
  }

  try {
    for (const item of items) {
      const fields = readSecurityFields(item.fields)
      const kind = classifyRule(fields.ruleId)
      if (!fields.siteId || !kind) continue

      const priorRule = findWafRule(await loadRules(fields.siteId), fields.ruleId)
      previous.push({
        siteId: fields.siteId,
        ruleId: fields.ruleId,
        kind,
        prior: priorRule ? liveSecurityValues(priorRule, kind) : {},
      })

      await configureSecurity(client, fields.siteId, fields.ruleId, declaredSecurityValues(fields))
      applied.push(`${fields.ruleId} (site ${fields.siteId})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} security rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Security rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

/** POST /sites/configure/security and assert the `res === 0` envelope. */
async function configureSecurity(
  client: ImpervaClient,
  siteId: string,
  ruleId: string,
  values: Record<string, string>,
): Promise<void> {
  const res = await client.post(SECURITY_CONFIGURE_PATH, { site_id: siteId, rule_id: ruleId, ...values })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) {
    throw new Error(`configure ${ruleId} (site ${siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
  }
}
