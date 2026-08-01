import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient } from '../../lib/visionOneApi'
import { EXCEPTION_ENDPOINTS, findObject, normalizeValue, objectsFromResponse } from './_shared'

/**
 * Drift for the exception list. Presence IS the configuration here, so — only when
 * the live list reads back cleanly — a declared exception that is ABSENT is drift
 * (someone removed it), and a present exception whose description differs from what
 * we declare is drift. A read failure asserts no drift (best-effort) rather than
 * raising false positives. Read-only: GET /threatintel/suspiciousObjectExceptions.
 *
 * VERIFY the list response shape + object field names against a live Vision One
 * tenant.
 */
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
    const res = await client.get(EXCEPTION_ENDPOINTS.list)
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = objectsFromResponse(res.json)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const value = String(item.fields.value ?? '').trim()
    if (!value) continue
    const match = findObject(live, value)

    if (!match) {
      // Declared exception is gone from the live list — the list read succeeded,
      // so this is genuine drift (the object is no longer excluded).
      diffs.push({ field: `${value}.present`, expected: 'true', actual: 'false', severity: 'warning' })
      continue
    }

    const expected = String(item.fields.description ?? '').trim()
    if (!expected) continue // no declared description — nothing else to assert
    const actual = String((match as Record<string, unknown>).description ?? '').trim()
    if (normalizeValue(actual) !== normalizeValue(expected)) {
      diffs.push({ field: `${value}.description`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
