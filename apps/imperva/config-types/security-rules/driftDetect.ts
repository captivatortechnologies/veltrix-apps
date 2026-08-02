import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, fetchSiteStatus } from '../../lib/impervaApi'
import {
  classifyRule,
  declaredSecurityValues,
  findWafRule,
  liveSecurityValues,
  readSecurityFields,
  wafRulesFromStatus,
  type WafRuleStatus,
} from './_shared'

/**
 * Drift for security-rules: for each declared rule, compare the parameter values
 * we declare against the live rule in Imperva (read from /sites/status →
 * security.waf.rules[]). Only the parameters the item actually declares are
 * compared, so an unset optional never raises drift. Best-effort — a site whose
 * status can't be read, or a rule not present, is skipped. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const rulesBySite = new Map<string, WafRuleStatus[]>()
  const loadRules = async (siteId: string): Promise<WafRuleStatus[] | null> => {
    if (rulesBySite.has(siteId)) return rulesBySite.get(siteId) ?? null
    try {
      const rules = wafRulesFromStatus(await fetchSiteStatus(client, siteId))
      rulesBySite.set(siteId, rules)
      return rules
    } catch {
      return null
    }
  }

  for (const item of items) {
    const fields = readSecurityFields(item.fields)
    const kind = classifyRule(fields.ruleId)
    if (!fields.siteId || !kind) continue

    const rules = await loadRules(fields.siteId)
    if (!rules) continue
    const match = findWafRule(rules, fields.ruleId)
    if (!match) continue

    const declared = declaredSecurityValues(fields)
    const live = liveSecurityValues(match, kind)
    const label = `${fields.ruleId} (site ${fields.siteId})`

    for (const [param, expected] of Object.entries(declared)) {
      const actual = live[param] ?? ''
      if (actual !== expected) {
        diffs.push({ field: `${label}.${param}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
