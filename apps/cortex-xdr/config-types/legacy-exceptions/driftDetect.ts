import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { LEGACY_EXCEPTION_ENDPOINTS, findException, exceptionsFromReply, normalizeName } from './_shared'

/**
 * Drift for legacy exceptions: compare platform, module, status and scope we
 * declare against the live exception in Cortex XDR. `conditions` and
 * `profile_ids` are not diffed — the condition shape varies per module and the
 * live field-name mapping is unverified. Best-effort — an exception that can't
 * be matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: POST /legacy_exceptions/fetch/.
 *
 * VERIFY the fetch response shape + field names against a live Cortex XDR
 * tenant.
 */
const COMPARED_FIELDS: Array<'platform' | 'status' | 'scope'> = ['platform', 'status', 'scope']

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
    const res = await client.call(LEGACY_EXCEPTION_ENDPOINTS.fetch, { search_from: 0, search_to: 1000 })
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = exceptionsFromReply(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findException(live, name)
    if (!match) continue

    for (const field of COMPARED_FIELDS) {
      const expected = String(item.fields[field] ?? '').trim()
      if (!expected) continue
      const actual = String((match as Record<string, unknown>)[field] ?? '').trim()
      if (normalizeName(actual) !== normalizeName(expected)) {
        diffs.push({ field: `${name}.${field}`, expected, actual, severity: 'warning' })
      }
    }

    const expectedModule = Number(item.fields.module ?? 0)
    if (expectedModule && expectedModule !== Number(match.module ?? 0)) {
      diffs.push({ field: `${name}.module`, expected: expectedModule, actual: match.module, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
