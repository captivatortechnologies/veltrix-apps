import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  fetchSiteStatus,
  ACL_CONFIGURE_PATH,
  isAclApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaClient,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'
import {
  aclParamsFromValues,
  aclRulesFromStatus,
  classifyAcl,
  declaredAclValues,
  findAclRule,
  liveAclValues,
  readAclFields,
  type AclKind,
  type AclRuleStatus,
  type AclValues,
} from './_shared'

/**
 * Deploy Imperva Cloud WAF ACLs over the Cloud WAF (Incapsula) API v1. Each ACL
 * type is a SINGLETON per site, SET declaratively (the value REPLACES the whole
 * list for that type on the site):
 *   read prior (rollback):  POST /sites/status         { site_id }
 *   set:                    POST /sites/configure/acl  { site_id, rule_id, ... }
 *
 * The ACL endpoint reports success with res 0 OR 2 (see isAclApiSuccess).
 * `rollbackData.previous` records, per (site, ACL type), the prior value set read
 * from the site status BEFORE the change — so rollback can re-apply it.
 */

interface PriorEntry {
  siteId: string
  aclId: string
  kind: AclKind
  prior: AclValues
}

const EMPTY_VALUES: AclValues = { ips: [], countries: [], continents: [], urls: [], urlPatterns: [] }

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []
  const rulesBySite = new Map<string, AclRuleStatus[]>()

  const loadRules = async (siteId: string): Promise<AclRuleStatus[]> => {
    if (!rulesBySite.has(siteId)) {
      rulesBySite.set(siteId, aclRulesFromStatus(await fetchSiteStatus(client, siteId)))
    }
    return rulesBySite.get(siteId) ?? []
  }

  try {
    for (const item of items) {
      const fields = readAclFields(item.fields)
      const kind = classifyAcl(fields.aclId)
      if (!fields.siteId || !kind) continue

      const priorRule = findAclRule(await loadRules(fields.siteId), fields.aclId)
      previous.push({
        siteId: fields.siteId,
        aclId: fields.aclId,
        kind,
        prior: priorRule ? liveAclValues(priorRule) : EMPTY_VALUES,
      })

      await configureAcl(client, fields.siteId, fields.aclId, aclParamsFromValues(kind, declaredAclValues(fields)))
      applied.push(`${fields.aclId} (site ${fields.siteId})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} ACL(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `ACL deploy failed after ${applied.length} ACL(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

/** POST /sites/configure/acl and assert the ACL success envelope (res 0 or 2). */
async function configureAcl(
  client: ImpervaClient,
  siteId: string,
  aclId: string,
  params: Record<string, string>,
): Promise<void> {
  const res = await client.post(ACL_CONFIGURE_PATH, { site_id: siteId, rule_id: aclId, ...params })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isAclApiSuccess(json)) {
    throw new Error(`configure ${aclId} (site ${siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
  }
}
