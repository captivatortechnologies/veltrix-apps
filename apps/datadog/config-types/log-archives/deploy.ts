import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import { archiveKey, buildArchiveBody, extractArchiveSpecs, parseJsonObject, parseOptionalNumber, toPayload, type ArchiveResource } from './_shared'

/**
 * Deploy Log Archives via GET/POST/PUT/DELETE
 * /api/v2/logs/config/archives[/{archive_id}]:
 *   https://docs.datadoghq.com/api/latest/logs-archives/create-an-archive/
 *
 * Identity is the archive NAME (case-insensitive). Live archives are listed,
 * matched by name, and:
 *   - a match is UPDATED (PUT, full-replace); its full prior attributes are
 *     captured for rollback first.
 *   - no match is CREATED (POST); the id is recorded so rollback can delete
 *     it.
 * Does NOT manage archive ORDER or reader-role grants (see _shared.ts).
 */
export interface ArchiveRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: ArchiveResource
}

const ARCHIVES_PATH = '/api/v2/logs/config/archives'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractArchiveSpecs(ctx.canvas).filter((s) => s.name && s.query)
  const rollbackState: ArchiveRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listArchives(client)
    const byKey = new Map(existing.filter((a) => a.attributes?.name).map((a) => [archiveKey(a.attributes!.name as string), a]))

    for (const spec of specs) {
      const label = spec.name
      const key = archiveKey(spec.name)

      const destination = parseJsonObject(spec.destinationRaw)
      const maxScanSize = parseOptionalNumber(spec.maxScanSizeRaw)
      if (!destination.ok || !destination.value || Number.isNaN(maxScanSize)) {
        throw new Error(`Archive "${label}": destination/rehydration_max_scan_size_in_gb are invalid — validate this configuration before deploying`)
      }
      const body = buildArchiveBody(spec, destination.value, maxScanSize)

      const live = byKey.get(key)

      if (live && live.id) {
        const prior = await readArchive(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })

        const res = await client.request('PUT', `${ARCHIVES_PATH}/${encodeURIComponent(live.id)}`, { body: toPayload(body) })
        if (!res.ok) throw new Error(`Failed to update archive "${label}": ${datadogErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', ARCHIVES_PATH, { body: toPayload(body) })
        if (!res.ok) throw new Error(`Failed to create archive "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<{ data?: ArchiveResource }>(res.body)
        const id = created?.data?.id
        if (!id) throw new Error(`Archive "${label}" was created but Datadog returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Log Archive(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedArchives: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Log archive deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedArchives: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

export async function listArchives(client: DatadogClient): Promise<ArchiveResource[]> {
  const res = await client.request('GET', ARCHIVES_PATH)
  if (!res.ok) throw new Error(`Failed to list Log Archives: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: ArchiveResource[] }>(res.body)
  return Array.isArray(parsed?.data) ? (parsed?.data as ArchiveResource[]) : []
}

export async function readArchive(client: DatadogClient, id: string): Promise<ArchiveResource> {
  const res = await client.request('GET', `${ARCHIVES_PATH}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Failed to read archive ${id}: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: ArchiveResource }>(res.body)
  if (!parsed?.data) throw new Error(`Archive ${id} was not found`)
  return parsed.data
}
