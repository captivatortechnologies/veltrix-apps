import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson } from '../../lib/sumoLogicApi'
import { findToken, tokensFromList, type Token } from './_shared'

/**
 * Drift for tokens: compare description and status we declare against the
 * live token in Sumo Logic (matched by name). Best-effort — a token that can't
 * be matched is skipped. Read-only: GET /tokens.
 *
 * API: https://help.sumologic.com/docs/api/tokens-library-token-management/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live: Token[]
  try {
    live = tokensFromList(await getJson<unknown>(`${base}/tokens`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read tokens, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findToken(live, name)
    if (!match) continue

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (actualDescription !== expectedDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    const expectedStatus = String(item.fields.status ?? '').trim() || 'Active'
    const actualStatus = String(match.status ?? '').trim()
    if (actualStatus && actualStatus !== expectedStatus) {
      diffs.push({ field: `${name}.status`, expected: expectedStatus, actual: actualStatus, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
