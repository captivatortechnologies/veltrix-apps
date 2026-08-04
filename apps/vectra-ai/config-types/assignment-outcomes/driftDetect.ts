import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson } from '../../lib/vectraApi'
import { outcomesFromList, findOutcome } from './_shared'

/**
 * Drift for assignment outcomes: compare the declared category against the live
 * outcome in Vectra, matched by title. Best-effort — an outcome that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /assignment_outcomes.
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
    live = outcomesFromList(await getJson<unknown>(`${base}/assignment_outcomes`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read outcomes, no drift asserted
  }

  for (const item of items) {
    const title = String(item.fields.title ?? '').trim()
    const match = findOutcome(live, title)
    if (!match) continue

    const expected = String(item.fields.category ?? '').trim()
    const actual = String(match.category ?? '').trim()
    if (expected !== actual) {
      diffs.push({ field: `${title}.category`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
