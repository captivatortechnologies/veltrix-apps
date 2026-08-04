import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson } from '../../lib/vectraApi'
import { buildDesiredState, stateFromGet, sortedJoin } from './_shared'

/**
 * Drift for the Internal Networks singleton: compare each declared list against the
 * live brain-wide configuration, order-insensitively. Read-only: GET
 * /settings/internal_network.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []
  const item = items[0]
  if (!item) return { hasDrift: false, diffs }

  if (!credential) return { hasDrift: false, diffs }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = stateFromGet(await getJson<unknown>(`${base}/settings/internal_network`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read settings, no drift asserted
  }

  const desired = buildDesiredState(item.fields)
  ;(['include', 'exclude', 'drop'] as const).forEach((key) => {
    const expected = sortedJoin(desired[key])
    const actual = sortedJoin(live[key])
    if (expected !== actual) {
      diffs.push({ field: key, expected, actual, severity: 'warning' })
    }
  })

  return { hasDrift: diffs.length > 0, diffs }
}
