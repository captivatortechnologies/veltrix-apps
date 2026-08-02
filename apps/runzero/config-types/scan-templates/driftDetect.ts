import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { findTemplate, readKeyValueMap, paramsEqual, text, type RunzeroScanTemplate } from './_shared'

/**
 * Drift for scan templates: compare the description, global flag and scan parameters we declare
 * against the live template in runZero, matched by name. A declared template that is missing
 * entirely is critical drift. Best-effort — if the template list can't be read (transient error,
 * or an Organization key without account scope) no drift is asserted rather than raising a false
 * positive. Read-only: GET /account/tasks/templates.
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

  let live: RunzeroScanTemplate[]
  try {
    live = coerceList<RunzeroScanTemplate>(await getJson<unknown>(`${base}/account/tasks/templates`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read templates, no drift asserted
  }

  for (const item of items) {
    const name = text(item.fields.name)
    if (!name) continue

    const match = findTemplate(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedDescription = text(item.fields.description)
    const actualDescription = text(match.description)
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedGlobal = item.fields.global === true
    const actualGlobal = match.global === true
    if (expectedGlobal !== actualGlobal) {
      diffs.push({ field: `${name}.global`, expected: String(expectedGlobal), actual: String(actualGlobal), severity: 'warning' })
    }

    const expectedParams = readKeyValueMap(item.fields.params)
    const actualParams = match.params ?? {}
    if (!paramsEqual(expectedParams, actualParams)) {
      diffs.push({
        field: `${name}.params`,
        expected: JSON.stringify(expectedParams),
        actual: JSON.stringify(actualParams),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
