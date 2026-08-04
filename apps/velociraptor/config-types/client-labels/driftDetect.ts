import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import { buildClient, vqlTimeoutMs, liveClientIdsForLabel, diffIds } from './_shared'

/**
 * Drift for client-labels: compare each declared label's desired membership
 * against the live client ids currently carrying it. A declared member missing
 * live is critical drift (the label didn't take, or was removed out-of-band); an
 * extra live member not declared is a warning (someone/something else labelled
 * it). A disabled label with any live members is critical (should be empty).
 * Read-only: SELECT client_id FROM clients(search='label:<label>').
 *
 * VERIFY against a live Velociraptor server: clients(search=) (see ./_shared.ts).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch {
    return { hasDrift: false, diffs }
  }

  try {
    const timeoutMs = vqlTimeoutMs(settings)
    for (const item of items) {
      const label = String(item.fields.label ?? '').trim()
      if (!label) continue
      const enabled = asBool(item.fields.enabled, true)
      const desired = enabled ? splitList(item.fields.clientIds) : []
      const live = await liveClientIdsForLabel(client, label, timeoutMs)

      const missing = diffIds(desired, live)
      const extra = diffIds(live, desired)
      if (missing.length === 0 && extra.length === 0) continue

      diffs.push({
        field: `${label}.members`,
        expected: desired.join(', ') || '(none)',
        actual: live.join(', ') || '(none)',
        severity: missing.length > 0 || !enabled ? 'critical' : 'warning',
      })
    }

    return { hasDrift: diffs.length > 0, diffs }
  } finally {
    await client.close().catch(() => {})
  }
}
