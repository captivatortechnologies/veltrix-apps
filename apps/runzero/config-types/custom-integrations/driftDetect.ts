import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { findCustomIntegration, text, type RunzeroCustomIntegration } from './_shared'

/**
 * Drift for custom integrations: compare the description and icon we declare against the live
 * integration in runZero, matched by name. A declared integration that is missing entirely is
 * critical drift. Best-effort — if the list can't be read (transient error, or an Organization key
 * without account scope) no drift is asserted rather than raising a false positive. Read-only:
 * GET /account/custom-integrations.
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

  let live: RunzeroCustomIntegration[]
  try {
    live = coerceList<RunzeroCustomIntegration>(await getJson<unknown>(`${base}/account/custom-integrations`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read integrations, no drift asserted
  }

  for (const item of items) {
    const name = text(item.fields.name)
    if (!name) continue

    const match = findCustomIntegration(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedDescription = text(item.fields.description)
    const actualDescription = text(match.description)
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedIcon = text(item.fields.iconBase64)
    const actualIcon = text(match.icon)
    if (expectedIcon && expectedIcon !== actualIcon) {
      diffs.push({ field: `${name}.icon`, expected: '(declared icon)', actual: '(live icon differs)', severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
