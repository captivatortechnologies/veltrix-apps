import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import { buildMonitorBody, extractMonitorSpecs, monitorKey, parseJsonObject, parsePriority, type DatadogMonitor } from './_shared'

/**
 * Deploy Datadog Monitors via GET/POST/PUT/DELETE
 * /api/v1/monitor[/{monitor_id}]:
 *   https://docs.datadoghq.com/api/latest/monitors/create-a-monitor/
 *   https://docs.datadoghq.com/api/latest/monitors/edit-a-monitor/
 *
 * Identity is the monitor NAME (case-insensitive). The org's live monitors
 * are listed, matched by name, and:
 *   - a match is UPDATED (PUT, full-replace); its full prior state is
 *     captured for rollback first. No optimistic-concurrency token is
 *     documented for this API (unlike Security Monitoring Rules), so no
 *     version field is sent.
 *   - no match is CREATED (POST); the numeric id is recorded so rollback can
 *     delete it.
 */
export interface MonitorRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  prior?: DatadogMonitor
}

const MONITOR_PATH = '/api/v1/monitor'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractMonitorSpecs(ctx.canvas).filter((s) => s.name && s.type && s.query)
  const rollbackState: MonitorRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listMonitors(client)
    const byKey = new Map(existing.filter((m) => m.name).map((m) => [monitorKey(m.name as string), m]))

    for (const spec of specs) {
      const label = spec.name
      const key = monitorKey(spec.name)

      const options = parseJsonObject(spec.optionsRaw)
      if (!options.ok) {
        throw new Error(`Monitor "${label}": options must be valid JSON — validate this configuration before deploying`)
      }
      const priority = parsePriority(spec.priorityRaw)
      if (Number.isNaN(priority)) {
        throw new Error(`Monitor "${label}": priority must be a number — validate this configuration before deploying`)
      }

      const live = byKey.get(key)

      if (live && typeof live.id === 'number') {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })

        const body = buildMonitorBody(spec, options.value ?? {}, priority)
        const res = await client.request('PUT', `${MONITOR_PATH}/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update monitor "${label}": ${datadogErrorMessage(res)}`)
      } else {
        const body = buildMonitorBody(spec, options.value ?? {}, priority)
        const res = await client.request('POST', MONITOR_PATH, { body })
        if (!res.ok) throw new Error(`Failed to create monitor "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<DatadogMonitor>(res.body)
        const id = created?.id
        if (typeof id !== 'number') throw new Error(`Monitor "${label}" was created but Datadog returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Monitor(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedMonitors: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Monitor deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedMonitors: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

/** List every Monitor. GET /api/v1/monitor returns a plain JSON array of full monitor objects. */
export async function listMonitors(client: DatadogClient): Promise<DatadogMonitor[]> {
  const res = await client.request('GET', MONITOR_PATH)
  if (!res.ok) throw new Error(`Failed to list Monitors: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<DatadogMonitor[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

/** Read one monitor's full, authoritative state. Throws on error. */
export async function readMonitor(client: DatadogClient, id: number): Promise<DatadogMonitor> {
  const res = await client.request('GET', `${MONITOR_PATH}/${id}`)
  if (!res.ok) throw new Error(`Failed to read monitor ${id}: ${datadogErrorMessage(res)}`)
  const monitor = parseJson<DatadogMonitor>(res.body)
  if (!monitor) throw new Error(`Monitor ${id} was not found`)
  return monitor
}
