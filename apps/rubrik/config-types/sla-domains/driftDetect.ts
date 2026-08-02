import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildFrequencies, findSlaByName, normalizeName, slaDomainsFromList, summarizeFrequencies, TIERS } from './_shared'

/**
 * Drift for SLA Domains: compare the snapshot tiers (and description) we declare
 * against the live SLA Domain in Rubrik. Best-effort — an SLA that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /api/v2/sla_domain. Verify against a live Rubrik CDM.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveServiceAccount(credential)) return { hasDrift: false, diffs }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't connect, no drift asserted
  }

  let live
  try {
    live = slaDomainsFromList(await getJson<unknown>(conn, '/api/v2/sla_domain'))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = normalizeName(item.fields.name)
    const match = findSlaByName(live, name)
    if (!match) continue

    const expected = summarizeFrequencies(buildFrequencies(item.fields))
    const actual = summarizeFrequencies(match.frequencies)

    for (const tier of TIERS) {
      const e = expected[tier] ?? '(off)'
      const a = actual[tier] ?? '(off)'
      if (e !== a) {
        diffs.push({ field: `${name}.${tier}`, expected: e, actual: a, severity: 'warning' })
      }
    }

    const expectedDesc = normalizeName(item.fields.description)
    const actualDesc = normalizeName(match.description)
    if (expectedDesc && expectedDesc !== actualDesc) {
      diffs.push({ field: `${name}.description`, expected: expectedDesc, actual: actualDesc, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
