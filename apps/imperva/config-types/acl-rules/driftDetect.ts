import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, INCAP_RULES_LIST_PATH, isApiSuccess, parseJson, type ImpervaEnvelope } from '../../lib/impervaApi'
import { findRule, normalizeEnabled, readRuleFields, rulesFromResponse, type IncapRule } from './_shared'

/**
 * Drift for ACL rules: compare the action / filter / enabled state we declare
 * against the live rule in Imperva (matched by name within its site). Best-effort —
 * a rule that can't be matched (missing / transient error) is skipped rather than
 * raising false drift. Read-only: POST /sites/incapRules/list per distinct site.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const rulesBySite = new Map<string, IncapRule[]>()
  const loadRules = async (siteId: string): Promise<IncapRule[] | null> => {
    if (rulesBySite.has(siteId)) return rulesBySite.get(siteId) ?? null
    try {
      const res = await client.post(INCAP_RULES_LIST_PATH, { site_id: siteId })
      const json = parseJson<ImpervaEnvelope>(res.body)
      if (!res.ok || !isApiSuccess(json)) return null
      const rules = rulesFromResponse(json)
      rulesBySite.set(siteId, rules)
      return rules
    } catch {
      return null // best-effort: can't read this site's rules, no drift asserted
    }
  }

  for (const item of items) {
    const fields = readRuleFields(item.fields)
    if (!fields.siteId || !fields.name) continue

    const rules = await loadRules(fields.siteId)
    if (!rules) continue
    const match = findRule(rules, fields.name)
    if (!match) continue

    const label = `${fields.name} (site ${fields.siteId})`

    const liveAction = String(match.action ?? '').trim()
    if (liveAction && liveAction !== fields.action) {
      diffs.push({ field: `${label}.action`, expected: fields.action, actual: liveAction, severity: 'warning' })
    }

    const liveFilter = String(match.filter ?? '').trim()
    if (liveFilter !== fields.filter) {
      diffs.push({ field: `${label}.filter`, expected: fields.filter, actual: liveFilter, severity: 'warning' })
    }

    const liveEnabled = normalizeEnabled(match.enabled)
    if (liveEnabled !== fields.enabled) {
      diffs.push({ field: `${label}.enabled`, expected: fields.enabled, actual: liveEnabled, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
