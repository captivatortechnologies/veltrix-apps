import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { organisationsFromList, findOrganisation, normalizeYesNo } from './_shared'

/**
 * Drift for organisations: compare the local flag, nationality and description we
 * declare against the live organisation in MISP. Best-effort — an org that can't
 * be matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: GET /organisations. Verify against a live MISP 2.4 instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = organisationsFromList(await getJson<unknown>(`${base}/organisations`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read organisations, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findOrganisation(live, name)
    if (!match) continue

    const expectedLocal = normalizeYesNo(item.fields.local)
    const actualLocal = normalizeYesNo(match.local)
    if (actualLocal !== expectedLocal) {
      diffs.push({ field: `${name}.local`, expected: expectedLocal, actual: actualLocal, severity: 'warning' })
    }

    const expectedNationality = String(item.fields.nationality ?? '').trim()
    const actualNationality = String(match.nationality ?? '').trim()
    if (expectedNationality && actualNationality !== expectedNationality) {
      diffs.push({ field: `${name}.nationality`, expected: expectedNationality, actual: actualNationality, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
