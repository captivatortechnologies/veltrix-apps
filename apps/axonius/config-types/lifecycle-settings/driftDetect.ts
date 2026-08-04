import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, verifyTls } from '../../lib/axoniusApi'
import { LIFECYCLE_SETTINGS_RESOURCE, configFromResponse, parseOverrides } from './_shared'

/**
 * Drift for Lifecycle Settings: compare ONLY the declared top-level `overrides`
 * keys against the live config — a key this config type doesn't manage is
 * never compared, so operator/other-tool changes outside the declared keys
 * never surface as drift. Read-only: GET
 * api/settings/plugins/system_scheduler/SystemSchedulerService. Best-effort.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []
  if (!item) return { hasDrift: false, diffs }

  if (!credential) return { hasDrift: false, diffs }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) return { hasDrift: false, diffs }

  const overrides = parseOverrides(item.fields.overrides)
  if (!overrides.ok || Object.keys(overrides.value).length === 0) return { hasDrift: false, diffs }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)

  let live: Record<string, unknown>
  try {
    live = configFromResponse(await getJson<unknown>(apiUrl(base, settings, LIFECYCLE_SETTINGS_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read settings, no drift asserted
  }

  for (const [key, expected] of Object.entries(overrides.value)) {
    const actual = live[key]
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      diffs.push({ field: key, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
