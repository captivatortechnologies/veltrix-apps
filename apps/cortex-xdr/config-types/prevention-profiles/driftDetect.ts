import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { PREVENTION_PROFILE_ENDPOINTS, findProfile, profilesFromReply } from './_shared'

/**
 * Drift for prevention profiles: compare description we declare against the
 * live profile in Cortex XDR. `modules` is not diffed field-by-field — its
 * shape is module-specific and not independently verified here (see
 * _shared.ts) — but a live profile whose `modules` JSON differs at all from the
 * declared one is flagged as drifted via a coarse deep-equality check. Best-
 * effort — a profile that can't be matched (missing / transient error) is
 * skipped rather than raising false drift. Read-only: POST /endpoints/get_profiles/.
 *
 * VERIFY the get_profiles response shape + field names against a live Cortex
 * XDR tenant.
 */
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
    const res = await client.call(PREVENTION_PROFILE_ENDPOINTS.get, { type: 'prevention' })
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = profilesFromReply(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findProfile(live, name)
    if (!match) continue

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription && expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    const rawModules = String(item.fields.modules ?? '').trim()
    if (rawModules) {
      try {
        const expectedModules = JSON.parse(rawModules)
        if (JSON.stringify(expectedModules) !== JSON.stringify(match.modules ?? {})) {
          diffs.push({ field: `${name}.modules`, expected: expectedModules, actual: match.modules, severity: 'warning' })
        }
      } catch {
        // invalid JSON is a validate.ts concern, not drift
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
