import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, fetchSiteStatus } from '../../lib/impervaApi'
import {
  aclRulesFromStatus,
  classifyAcl,
  declaredAclValues,
  findAclRule,
  liveAclValues,
  readAclFields,
  sameSet,
  urlPairs,
  type AclRuleStatus,
} from './_shared'

/**
 * Drift for acl-configuration: for each declared ACL, compare the value set we
 * declare against the live ACL in Imperva (read from /sites/status →
 * security.acls.rules[]). Lists are compared order-insensitively; URLs compare as
 * value|pattern pairs. Best-effort — a site whose status can't be read, or an ACL
 * not present, is skipped. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const rulesBySite = new Map<string, AclRuleStatus[]>()
  const loadRules = async (siteId: string): Promise<AclRuleStatus[] | null> => {
    if (rulesBySite.has(siteId)) return rulesBySite.get(siteId) ?? null
    try {
      const rules = aclRulesFromStatus(await fetchSiteStatus(client, siteId))
      rulesBySite.set(siteId, rules)
      return rules
    } catch {
      return null
    }
  }

  for (const item of items) {
    const fields = readAclFields(item.fields)
    const kind = classifyAcl(fields.aclId)
    if (!fields.siteId || !kind) continue

    const rules = await loadRules(fields.siteId)
    if (!rules) continue
    const match = findAclRule(rules, fields.aclId)
    if (!match) continue

    const declared = declaredAclValues(fields)
    const live = liveAclValues(match)
    const label = `${fields.aclId} (site ${fields.siteId})`
    const diff = (field: string, expected: string[], actual: string[]) =>
      diffs.push({ field: `${label}.${field}`, expected: [...expected].sort().join(', '), actual: [...actual].sort().join(', '), severity: 'warning' })

    if (kind === 'ips') {
      if (!sameSet(declared.ips, live.ips)) diff('ips', declared.ips, live.ips)
    } else if (kind === 'geo') {
      if (!sameSet(declared.countries, live.countries)) diff('countries', declared.countries, live.countries)
      if (!sameSet(declared.continents, live.continents)) diff('continents', declared.continents, live.continents)
    } else if (kind === 'urls') {
      if (!sameSet(urlPairs(declared), urlPairs(live))) diff('urls', urlPairs(declared), urlPairs(live))
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
