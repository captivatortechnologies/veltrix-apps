import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, fetchSiteStatus } from '../../lib/impervaApi'
import { exceptionSignature, liveExceptionFields, readExceptionFields, ruleFamily, statusRulesFor } from './_shared'

/**
 * Drift for security rule exceptions: for each declared (site, rule) group,
 * compare the set of declared exception signatures against the set of live
 * ones (read from /sites/status). Reported as a single count-mismatch diff per
 * group rather than per-exception, since an exception has no stable name to
 * label an individual diff with. Best-effort — a site/rule whose status can't
 * be read is skipped. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const groups = new Map<string, { siteId: string; ruleId: string; declaredSignatures: Set<string> }>()
  for (const item of items) {
    const fields = readExceptionFields(item.fields)
    const family = ruleFamily(fields.ruleId)
    if (!fields.siteId || !family) continue
    const key = `${fields.siteId}::${fields.ruleId}`
    if (!groups.has(key)) groups.set(key, { siteId: fields.siteId, ruleId: fields.ruleId, declaredSignatures: new Set() })
    groups.get(key)!.declaredSignatures.add(exceptionSignature(fields))
  }

  for (const { siteId, ruleId, declaredSignatures } of groups.values()) {
    const family = ruleFamily(ruleId)!
    let liveSignatures: Set<string>
    try {
      const status = await fetchSiteStatus(client, siteId)
      const rule = statusRulesFor(status, family).find((r) => r.id === ruleId)
      liveSignatures = new Set((rule?.exceptions ?? []).map((exc) => exceptionSignature(liveExceptionFields(ruleId, siteId, exc))))
    } catch {
      continue
    }

    const label = `${ruleId} (site ${siteId})`
    const missing = [...declaredSignatures].filter((s) => !liveSignatures.has(s)).length
    const extra = [...liveSignatures].filter((s) => !declaredSignatures.has(s)).length
    if (missing > 0 || extra > 0) {
      diffs.push({
        field: `${label}.exceptions`,
        expected: `${declaredSignatures.size} declared`,
        actual: `${liveSignatures.size} live (${missing} missing, ${extra} undeclared)`,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
