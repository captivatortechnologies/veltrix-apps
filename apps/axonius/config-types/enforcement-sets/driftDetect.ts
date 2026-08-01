import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, verifyTls } from '../../lib/axoniusApi'
import { ENFORCEMENTS_LIST_RESOURCE, enforcementsFromResponse, findEnforcement, liveActionName, parseText } from './_shared'

/**
 * Drift for enforcement sets: confirm each declared set still exists and still
 * runs the declared main action. The list endpoint returns a summary
 * (`actions_main_type`), so we assert existence + the main action_name — a cheap,
 * verified signal. The per-action config internals are not compared here (that
 * would need a full GET per set); config-level drift is out of scope. Best-effort:
 * a transient read error raises no false drift. Read-only: GET api/enforcements.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) return { hasDrift: false, diffs }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)

  let live
  try {
    live = enforcementsFromResponse(
      await getJson<unknown>(apiUrl(base, settings, ENFORCEMENTS_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read sets, no drift asserted
  }

  for (const item of items) {
    const name = parseText(item.fields.name)
    if (!name) continue
    const match = findEnforcement(live, name)

    if (!match) {
      diffs.push({ field: `${name}.exists`, expected: true, actual: false, severity: 'critical' })
      continue
    }

    const expectedAction = parseText(item.fields.action_name)
    const actualAction = liveActionName(match)
    if (expectedAction && expectedAction !== actualAction) {
      diffs.push({ field: `${name}.action_name`, expected: expectedAction, actual: actualAction, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
