import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import {
  buildClient,
  vqlTimeoutMs,
  readClientMonitoring,
  liveArtifactsForLabel,
  GET_CLIENT_MONITORING_VQL,
  ALL_CLIENTS_LABEL,
  type ClientMonitoringConfig,
} from './_shared'

/** Compare two name lists as sets (order-independent). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/**
 * Drift for client monitoring: compare each authored label group's desired event
 * artifacts against what the live ClientEventTable holds for that group. Best-
 * effort — an unreadable config asserts no drift rather than false positives.
 * Read-only: SELECT get_client_monitoring().
 *
 * VERIFY against a live Velociraptor server: get_client_monitoring() value shape.
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
    let live: ClientMonitoringConfig | null
    try {
      live = readClientMonitoring(await client.runVQL(GET_CLIENT_MONITORING_VQL, { timeoutMs: vqlTimeoutMs(settings) }))
    } catch {
      return { hasDrift: false, diffs }
    }

    for (const item of items) {
      const label = String(item.fields.label ?? '').trim() || ALL_CLIENTS_LABEL
      const enabled = asBool(item.fields.enabled, true)
      const desired = enabled ? splitList(item.fields.artifacts) : []
      const actual = liveArtifactsForLabel(live, label)
      if (!sameSet(desired, actual)) {
        diffs.push({
          field: `${label}.artifacts`,
          expected: desired.join(', ') || '(none)',
          actual: actual.join(', ') || '(none)',
          severity: 'warning',
        })
      }
    }

    return { hasDrift: diffs.length > 0, diffs }
  } finally {
    await client.close().catch(() => {})
  }
}
