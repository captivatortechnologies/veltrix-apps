import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, findingIds } from '../../lib/semgrepApi'
import { buildFindingsQuery, extractTriageSpecs } from './_shared'

/**
 * Drift for triage rules — BEST-EFFORT (there is no server-side triage-rule to
 * compare against). For each rule, re-query GET /findings for findings that still
 * match the rule's selection AT ITS SOURCE STATUS (i.e. have NOT been moved to the
 * target state). Any such findings are reported as drift: either a later scan
 * surfaced new matching findings, or the earlier triage did not stick. Read-only;
 * a rule whose target state equals its source status asserts nothing.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, canvas } = ctx
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built
  if (!client.hasSlug) return { hasDrift: false, diffs }

  const specs = extractTriageSpecs(canvas).filter((s) => s.ruleName)

  for (const spec of specs) {
    // A rule that leaves findings in their source status can't drift by this check.
    if (spec.targetState === spec.fromStatus) continue

    let res
    try {
      res = await client.listFindings(buildFindingsQuery(spec))
    } catch {
      continue // best-effort: can't read, no drift asserted
    }
    if (!res.ok) continue

    const remaining = findingIds(res).length
    if (remaining > 0) {
      diffs.push({
        field: `triage:${spec.ruleName}`,
        expected: `0 ${spec.issueType} findings in "${spec.fromStatus}" matching the rule`,
        actual: `${remaining}${remaining >= 100 ? '+' : ''} un-triaged finding(s) match — re-deploy to triage them`,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
