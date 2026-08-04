import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage } from '../../lib/cybereasonApi'
import { SENSORS_QUERY_ENDPOINT, TAG_FIELDS, sensorsFromResponse, buildPylumIdQuery, extractTagSnapshot, normalizeCriticalAsset } from './_shared'

/**
 * Drift for sensor tags: compare each declared, non-blank tag against the
 * sensor's current value (read via POST /rest/sensors/query). An optional tag
 * field the author left blank is not asserted (it maps to REMOVE at deploy
 * time, but drift only flags tags the author actively declared a value for — a
 * tag set outside Veltrix on a field left blank is not reported as drift).
 * Read-only. Best-effort — a sensor that can't be read is skipped rather than
 * raising false drift; a declared pylumId with no matching sensor is critical.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  try {
    const session = await createSession(base, credential, timeoutMs)

    for (const item of items) {
      const pylumId = String(item.fields.pylumId ?? '').trim()
      if (!pylumId) continue

      let res
      try {
        res = await session.postJson(SENSORS_QUERY_ENDPOINT, buildPylumIdQuery(pylumId))
      } catch {
        continue // best-effort: can't reach this sensor, no drift asserted
      }
      if (!res.ok || looksLikeLoginPage(res.body)) continue

      const snapshot = extractTagSnapshot(sensorsFromResponse(res.body), pylumId)
      if (!snapshot) {
        diffs.push({ field: `${pylumId}`, expected: 'present', actual: '(absent)', severity: 'critical' })
        continue
      }

      for (const spec of TAG_FIELDS) {
        if (spec.type === 'boolean') {
          const declaredTri = normalizeCriticalAsset(item.fields.criticalAsset)
          if (declaredTri === '') continue // left blank — not asserted
          const declared = declaredTri === 'true'
          const actual = snapshot[spec.key]
          if (actual !== declared) {
            diffs.push({ field: `${pylumId}.${spec.key}`, expected: declared, actual, severity: 'warning' })
          }
        } else {
          const declared = String((item.fields as Record<string, unknown>)[spec.key] ?? '').trim()
          if (!declared) continue // left blank — not asserted
          const actual = snapshot[spec.key]
          if (actual !== declared) {
            diffs.push({ field: `${pylumId}.${spec.key}`, expected: declared, actual, severity: 'warning' })
          }
        }
      }
    }
  } catch {
    return { hasDrift: false, diffs }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
