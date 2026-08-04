import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { findOwnershipType, intOrUndefined, text, type RunzeroOwnershipType } from './_shared'

/**
 * Drift for asset ownership types: compare the sort order, hidden flag and reference code we
 * declare against the live type in runZero, matched by name. A declared type that is missing
 * entirely is critical drift. Best-effort — if the type list can't be read (transient error, or an
 * Organization key without account scope) no drift is asserted rather than raising a false
 * positive. Read-only: GET /account/assets/ownership-types.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveRunzeroToken(credential)) return { hasDrift: false, diffs }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout * 1000 : undefined

  let live: RunzeroOwnershipType[]
  try {
    live = coerceList<RunzeroOwnershipType>(await getJson<unknown>(`${base}/account/assets/ownership-types`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read ownership types, no drift asserted
  }

  for (const item of items) {
    const name = text(item.fields.name)
    if (!name) continue

    const match = findOwnershipType(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedOrder = intOrUndefined(item.fields.order)
    if (expectedOrder !== undefined && expectedOrder !== match.order) {
      diffs.push({ field: `${name}.order`, expected: String(expectedOrder), actual: String(match.order ?? ''), severity: 'info' })
    }

    const expectedReference = intOrUndefined(item.fields.reference)
    if (expectedReference !== undefined && expectedReference !== match.reference) {
      diffs.push({ field: `${name}.reference`, expected: String(expectedReference), actual: String(match.reference ?? ''), severity: 'info' })
    }

    const expectedHidden = item.fields.hidden === true
    const actualHidden = match.hidden === true
    if (expectedHidden !== actualHidden) {
      diffs.push({ field: `${name}.hidden`, expected: String(expectedHidden), actual: String(actualHidden), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
