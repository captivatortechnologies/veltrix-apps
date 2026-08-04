import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { BIOC_ENDPOINTS, findBioc, biocsFromReply, normalizeName } from './_shared'

/**
 * Drift for BIOCs: compare the type, severity and status we declare against the
 * live rule in Cortex XDR. Best-effort — a rule that can't be matched (missing /
 * transient error) is skipped rather than raising false drift. Read-only:
 * POST /bioc/get/.
 *
 * VERIFY the /bioc/get response shape + field names against a live Cortex XDR
 * tenant.
 */
const COMPARED_FIELDS: Array<'type' | 'severity' | 'status'> = ['type', 'severity', 'status']

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
    const res = await client.call(BIOC_ENDPOINTS.get, { search_from: 0, search_to: 1000 })
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = biocsFromReply(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findBioc(live, name)
    if (!match) continue

    for (const field of COMPARED_FIELDS) {
      const expected = String(item.fields[field] ?? '').trim()
      if (!expected) continue // an optional field the user left blank is not asserted
      const actual = String((match as Record<string, unknown>)[field] ?? '').trim()
      if (normalizeName(actual) !== normalizeName(expected)) {
        diffs.push({ field: `${name}.${field}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
