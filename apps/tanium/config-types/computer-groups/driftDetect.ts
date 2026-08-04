import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession, getJson } from '../../lib/taniumApi'
import { groupsFromList, findGroup, groupModeOf, computerSpecsOf, type TaniumComputerSpec } from './_shared'

/** A comparable, order-insensitive membership signature for a manual group's `computer_specs`. */
function membershipSignature(specs: TaniumComputerSpec[]): string {
  return specs
    .map((s) => (s.computer_name ? `c:${s.computer_name.toLowerCase()}` : `i:${String(s.ip_address ?? '').toLowerCase()}`))
    .sort()
    .join(',')
}

/**
 * Drift for computer groups: filter mode compares the declared filter expression
 * (text) against the live group; manual mode compares the declared computer/IP
 * membership list (order-insensitive). Best-effort — a group that can't be matched
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

    if (groupModeOf(item.fields) === 'manual') {
      const expectedSpecs = computerSpecsOf(item.fields)
      if (expectedSpecs.length === 0) continue
      const actualSpecs = Array.isArray(match.computer_specs) ? match.computer_specs : []
      const expected = membershipSignature(expectedSpecs)
      const actual = membershipSignature(actualSpecs)
      if (expected !== actual) {
        diffs.push({ field: `${name}.members`, expected, actual, severity: 'warning' })
      }
      continue
    }

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
