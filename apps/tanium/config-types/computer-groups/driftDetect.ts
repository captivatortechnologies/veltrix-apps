import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession, getJson } from '../../lib/taniumApi'
import { groupsFromList, findGroup } from './_shared'

/**
 * Drift for computer groups: compare the filter expression (text) we declare
 * against the live group in Tanium. Best-effort — a group that can't be matched
 * (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /api/v2/groups. Verify against a live Tanium.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)

  let live
  try {
    const session = await resolveTaniumSession(base, credential)
    live = groupsFromList(await getJson<unknown>(`${base}/groups`, session))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findGroup(live, name)
    if (!match) continue

    const expectedText = String(item.fields.filterText ?? '').trim()
    const actualText = String(match.text ?? '').trim()
    // Only assert text drift when we declare a filter expression (the structured
    // JSON path is not compared here — its live shape is unverified).
    if (expectedText && actualText !== expectedText) {
      diffs.push({ field: `${name}.filterText`, expected: expectedText, actual: actualText, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
