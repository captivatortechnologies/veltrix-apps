import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient } from '../../lib/visionOneApi'
import { SUSPICIOUS_OBJECT_ENDPOINTS, findObject, normalizeValue, objectsFromResponse } from './_shared'

/**
 * Drift for suspicious objects: compare the scan action + risk level we declare
 * against the live object in Vision One. Best-effort — an object that can't be
 * matched (removed / transient error) is skipped rather than raising false drift.
 * Read-only: GET /threatintel/suspiciousObjects.
 *
 * VERIFY the list response shape + object field names against a live Vision One
 * tenant.
 */
const COMPARED_FIELDS: Array<'scanAction' | 'riskLevel'> = ['scanAction', 'riskLevel']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.get(SUSPICIOUS_OBJECT_ENDPOINTS.list)
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = objectsFromResponse(res.json)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const value = String(item.fields.value ?? '').trim()
    if (!value) continue
    const match = findObject(live, value)
    if (!match) continue

    for (const field of COMPARED_FIELDS) {
      const expected = String(item.fields[field] ?? '').trim()
      if (!expected) continue // an optional field the user left blank is not asserted
      const actual = String((match as Record<string, unknown>)[field] ?? '').trim()
      if (normalizeValue(actual) !== normalizeValue(expected)) {
        diffs.push({ field: `${value}.${field}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
