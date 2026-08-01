import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson } from '../../lib/vectraApi'
import { rulesFromList, findRule, normalizeBool } from './_shared'

/**
 * Drift for triage rules: compare the classification we declare (triage_category,
 * is_whitelist, detection_category, detection) against the live rule in Vectra,
 * matched by description. Best-effort — a rule that can't be matched (missing /
 * transient error) is skipped rather than raising false drift. Read-only:
 * GET /rules. Verify against a live Vectra brain.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = rulesFromList(await getJson<unknown>(`${base}/rules?page_size=5000`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read rules, no drift asserted
  }

  for (const item of items) {
    const description = String(item.fields.description ?? '').trim()
    const match = findRule(live, description)
    if (!match) continue

    const expectedTriage = String(item.fields.triage_category ?? '').trim()
    const actualTriage = String(match.triage_category ?? '').trim()
    if (!normalizeBool(item.fields.is_whitelist) && expectedTriage && actualTriage !== expectedTriage) {
      diffs.push({ field: `${description}.triage_category`, expected: expectedTriage, actual: actualTriage, severity: 'warning' })
    }

    const expectedWhitelist = normalizeBool(item.fields.is_whitelist)
    const actualWhitelist = normalizeBool(match.is_whitelist)
    if (expectedWhitelist !== actualWhitelist) {
      diffs.push({ field: `${description}.is_whitelist`, expected: expectedWhitelist, actual: actualWhitelist, severity: 'warning' })
    }

    const expectedCategory = String(item.fields.detection_category ?? '').trim()
    const actualCategory = String(match.detection_category ?? '').trim()
    if (expectedCategory && actualCategory && expectedCategory !== actualCategory) {
      diffs.push({ field: `${description}.detection_category`, expected: expectedCategory, actual: actualCategory, severity: 'warning' })
    }

    const expectedDetection = String(item.fields.detection ?? '').trim()
    const actualDetection = String(match.detection ?? '').trim()
    if (expectedDetection && actualDetection && expectedDetection !== actualDetection) {
      diffs.push({ field: `${description}.detection`, expected: expectedDetection, actual: actualDetection, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
