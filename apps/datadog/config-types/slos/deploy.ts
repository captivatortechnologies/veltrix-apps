import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import { buildSloBody, extractSloSpecs, parseJsonArray, parseMonitorIds, sloKey, type DatadogSlo } from './_shared'

/**
 * Deploy SLOs via GET/POST/PUT/DELETE /api/v1/slo[/{slo_id}]:
 *   https://docs.datadoghq.com/api/latest/service-level-objectives/
 *
 * Identity is the SLO NAME (case-insensitive). Live SLOs are listed, matched
 * by name, and:
 *   - a match is UPDATED (PUT, full-replace); its full prior state is
 *     captured for rollback first.
 *   - no match is CREATED (POST); the id is recorded so rollback can delete
 *     it.
 */
export interface SloRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: DatadogSlo
}

const SLO_PATH = '/api/v1/slo'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractSloSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: SloRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSlos(client)
    const byKey = new Map(existing.filter((s) => s.name).map((s) => [sloKey(s.name as string), s]))

    for (const spec of specs) {
      const label = spec.name
      const key = sloKey(spec.name)

      const thresholds = parseJsonArray(spec.thresholdsRaw)
      const monitorIds = parseMonitorIds(spec.monitorIdsRaw)
      if (!thresholds.ok || !monitorIds.ok) {
        throw new Error(`SLO "${label}": thresholds/monitor_ids are invalid — validate this configuration before deploying`)
      }
      const body = buildSloBody(spec, thresholds.value ?? [], monitorIds.ids)

      const live = byKey.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `${SLO_PATH}/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update SLO "${label}": ${datadogErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', SLO_PATH, { body })
        if (!res.ok) throw new Error(`Failed to create SLO "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<{ data?: DatadogSlo[] }>(res.body)
        const id = created?.data?.[0]?.id
        if (!id) throw new Error(`SLO "${label}" was created but Datadog returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} SLO(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedSlos: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `SLO deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedSlos: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

/** List every SLO. GET /api/v1/slo returns { data: DatadogSlo[] }. */
export async function listSlos(client: DatadogClient): Promise<DatadogSlo[]> {
  const res = await client.request('GET', SLO_PATH)
  if (!res.ok) throw new Error(`Failed to list SLOs: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: DatadogSlo[] }>(res.body)
  return Array.isArray(parsed?.data) ? (parsed?.data as DatadogSlo[]) : []
}

export async function readSlo(client: DatadogClient, id: string): Promise<DatadogSlo> {
  const res = await client.request('GET', `${SLO_PATH}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Failed to read SLO ${id}: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: DatadogSlo }>(res.body)
  if (!parsed?.data) throw new Error(`SLO ${id} was not found`)
  return parsed.data
}
