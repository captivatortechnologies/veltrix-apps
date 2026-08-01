import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { IOC_ENDPOINTS, findIoc, iocsFromReply, normalizeIndicator } from './_shared'

/**
 * Drift for IOCs: compare the severity, reputation, reliability and type we
 * declare against the live indicator in Cortex XDR. Best-effort — an indicator
 * that can't be matched (missing / transient error) is skipped rather than
 * raising false drift. Read-only: POST /indicators/get_changes/.
 *
 * VERIFY the get_changes response shape + IOC field names against a live Cortex
 * XDR tenant.
 */
const COMPARED_FIELDS: Array<{ field: 'type' | 'severity' | 'reputation' | 'reliability' }> = [
  { field: 'type' },
  { field: 'severity' },
  { field: 'reputation' },
  { field: 'reliability' },
]

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.call(IOC_ENDPOINTS.getChanges, { ts: 0 })
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = iocsFromReply(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const indicator = String(item.fields.indicator ?? '').trim()
    if (!indicator) continue
    const match = findIoc(live, indicator)
    if (!match) continue

    for (const { field } of COMPARED_FIELDS) {
      const expected = String(item.fields[field] ?? '').trim()
      if (!expected) continue // an optional field the user left blank is not asserted
      const actual = String((match as Record<string, unknown>)[field] ?? '').trim()
      if (normalizeIndicator(actual) !== normalizeIndicator(expected)) {
        diffs.push({ field: `${indicator}.${field}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
