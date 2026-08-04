import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString, parseJsonObject } from '../../lib/coerce'
import { notificationsFromList, findNotification } from './_shared'

/**
 * Drift for notifications: compare the description and the declared `config`
 * keys against the live notification in Graylog. Only declared config keys are
 * compared (server-defaulted keys we did not set would otherwise raise false
 * drift). Best-effort, read-only: GET /api/events/notifications.
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
    live = notificationsFromList(await getJson<unknown>(`${base}/api/events/notifications`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const title = asString(item.fields.title)
    const match = findNotification(live, title)
    if (!match) continue

    const expectedDescription = asString(item.fields.description)
    const actualDescription = asString(match.description)
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${title}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const { value: expectedConfig } = parseJsonObject(item.fields.config)
    const actualConfig = (match.config && typeof match.config === 'object' ? match.config : {}) as Record<string, unknown>
    for (const key of Object.keys(expectedConfig)) {
      const exp = asString(expectedConfig[key])
      const act = asString(actualConfig[key])
      if (exp !== act) {
        diffs.push({ field: `${title}.config.${key}`, expected: exp, actual: act, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
