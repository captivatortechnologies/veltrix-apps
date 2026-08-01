import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import {
  buildClient,
  vqlTimeoutMs,
  readServerMonitoring,
  liveServerArtifacts,
  GET_SERVER_MONITORING_VQL,
  type ServerMonitoringConfig,
} from './_shared'

/** Compare two name lists as sets (order-independent). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/**
 * Drift for server monitoring: compare the authored server event-artifact list
 * against the live ServerMonitoringTable. Best-effort — an unreadable config
 * asserts no drift. Read-only: SELECT get_server_monitoring().
 *
 * VERIFY against a live Velociraptor server: get_server_monitoring() value shape.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []

  if (!credential || !item) return { hasDrift: false, diffs }

  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch {
    return { hasDrift: false, diffs }
  }

  try {
    let live: ServerMonitoringConfig | null
    try {
      live = readServerMonitoring(await client.runVQL(GET_SERVER_MONITORING_VQL, { timeoutMs: vqlTimeoutMs(settings) }))
    } catch {
      return { hasDrift: false, diffs }
    }

    const enabled = asBool(item.fields.enabled, true)
    const desired = enabled ? splitList(item.fields.artifacts) : []
    const actual = liveServerArtifacts(live)
    if (!sameSet(desired, actual)) {
      diffs.push({
        field: 'server.artifacts',
        expected: desired.join(', ') || '(none)',
        actual: actual.join(', ') || '(none)',
        severity: 'warning',
      })
    }

    return { hasDrift: diffs.length > 0, diffs }
  } finally {
    await client.close().catch(() => {})
  }
}
