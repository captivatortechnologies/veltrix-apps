import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession } from '../../lib/taniumApi'
import { getEntityByName } from '../../lib/taniumRestEntity'
import { SENSORS_RESOURCE, primaryQueryOf, type TaniumSensor } from './_shared'

/**
 * Drift for sensors: compare the declared primary script (and, when set, the max
 * age) against the live sensor's first query in Tanium. Best-effort — a sensor
 * that can't be matched (missing / transient error) is skipped rather than
 * raising false drift. Multi-platform "additional queries" are not compared —
 * only the primary query authored on the canvas item. Read-only:
 * GET /api/v2/sensors/by-name/{name}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)

  let session: string
  try {
    session = await resolveTaniumSession(base, credential)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    let match: TaniumSensor | null
    try {
      match = await getEntityByName<TaniumSensor>(base, session, SENSORS_RESOURCE, name)
    } catch {
      continue
    }
    if (!match) continue

    const actualQuery = primaryQueryOf(match)

    const expectedScript = String(item.fields.script ?? '').trim()
    const actualScript = String(actualQuery.script ?? '').trim()
    if (expectedScript && actualScript !== expectedScript) {
      diffs.push({ field: `${name}.script`, expected: expectedScript, actual: actualScript, severity: 'warning' })
    }

    const expectedMaxAge = String(item.fields.maxAgeSeconds ?? '').trim()
    if (expectedMaxAge && /^\d+$/.test(expectedMaxAge)) {
      const actualMaxAge = match.max_age_seconds
      if (actualMaxAge !== undefined && String(actualMaxAge) !== expectedMaxAge) {
        diffs.push({ field: `${name}.maxAgeSeconds`, expected: expectedMaxAge, actual: String(actualMaxAge), severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
