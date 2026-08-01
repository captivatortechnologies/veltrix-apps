import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { ALERT_EXCLUSION_ENDPOINTS, findExclusionByName, exclusionsFromReply, normalizeName } from './_shared'

/**
 * Drift for alert exclusions: compare the comment + disabled flag we declare
 * against the live exclusion in Cortex XDR. BEST-EFFORT and SPECULATIVE — the
 * read endpoint is not documented in the public API, so this almost always
 * returns no drift (an unreadable / unmatched exclusion is skipped rather than
 * raising a false positive). The `filter` field is not diffed (its live JSON
 * shape is unverified).
 *
 * VERIFY the list endpoint + response shape against a live Cortex XDR tenant.
 */
const COMPARED_FIELDS: Array<'comment' | 'disabled'> = ['comment', 'disabled']

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
    const res = await client.call(ALERT_EXCLUSION_ENDPOINTS.list, {})
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = exclusionsFromReply(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findExclusionByName(live, name)
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
