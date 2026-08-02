import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { resolveSiteId, findRecurringTask, normalizeFrequency, text, type RunzeroTask, type RunzeroSiteLite } from './_shared'

/**
 * Drift for scan tasks: for each declared RECURRING scan (a `once` scan owns no persistent task,
 * so it is skipped) confirm a matching recurring task still exists in runZero, matched by
 * (site, scan-name), and that its recurrence frequency still matches. A declared recurring scan
 * whose task is missing is critical drift. Best-effort — if the task/site lists can't be read
 * no drift is asserted rather than raising a false positive. Read-only: GET /org/sites + /org/tasks.
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

  let sites: RunzeroSiteLite[]
  let tasks: RunzeroTask[]
  try {
    sites = coerceList<RunzeroSiteLite>(await getJson<unknown>(`${base}/org/sites`, headers, timeoutMs))
    tasks = coerceList<RunzeroTask>(await getJson<unknown>(`${base}/org/tasks`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
  }

  for (const item of items) {
    const name = text(item.fields.scanName)
    const siteRef = text(item.fields.site)
    if (!name || !siteRef) continue

    const expectedFreq = normalizeFrequency(item.fields.frequency)
    if (expectedFreq === 'once') continue // a one-off scan leaves no recurring task to drift against

    const siteId = resolveSiteId(sites, siteRef)
    const match = findRecurringTask(tasks, siteId, name)
    if (!match) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const actualFreq = text(match.recur_frequency).toLowerCase()
    if (expectedFreq !== actualFreq) {
      diffs.push({ field: `${name}.frequency`, expected: expectedFreq, actual: actualFreq || '(none)', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
