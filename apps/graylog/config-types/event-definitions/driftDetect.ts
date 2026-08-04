import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString, toBool, toInt } from '../../lib/coerce'
import { eventDefinitionsFromList, findEventDefinition } from './_shared'

/**
 * Drift for event definitions: compare the priority, alert flag and enabled
 * (schedule) state we declare against the live definition in Graylog.
 * Best-effort — a definition that can't be matched is skipped rather than
 * raising false drift. Read-only: GET /api/events/definitions.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = eventDefinitionsFromList(await getJson<unknown>(`${base}/api/events/definitions`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const title = asString(item.fields.title)
    const match = findEventDefinition(live, title)
    if (!match) continue

    const expectedPriority = toInt(item.fields.priority, 2)
    const actualPriority = typeof match.priority === 'number' ? match.priority : 2
    if (expectedPriority !== actualPriority) {
      diffs.push({ field: `${title}.priority`, expected: String(expectedPriority), actual: String(actualPriority), severity: 'warning' })
    }

    const expectedEnabled = toBool(item.fields.enabled ?? true)
    const actualEnabled = asString(match.state) === 'ENABLED'
    if (expectedEnabled !== actualEnabled) {
      diffs.push({ field: `${title}.enabled`, expected: String(expectedEnabled), actual: String(actualEnabled), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
