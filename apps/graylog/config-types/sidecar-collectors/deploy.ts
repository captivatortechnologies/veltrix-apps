import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildSidecarCollectorBody, sidecarCollectorsFromList, findSidecarCollector, type GraylogSidecarCollector } from './_shared'

/**
 * Deploy Graylog Sidecar collectors over the REST API:
 *   read (rollback): GET  /api/sidecar/collectors       → find the live collector by (name, os)
 *   create:          POST /api/sidecar/collectors        → Collector { id, ... }
 *   update:          PUT  /api/sidecar/collectors/{id}   → Collector
 *
 * The (name, node_operating_system) PAIR is the stable identity used to
 * upsert. rollbackData records, per collector, the prior collector (null when
 * it did not exist) AND its id — so rollback can restore the prior definition
 * or delete the one we created.
 */
interface SidecarCollectorSaveResponse {
  id?: string
}

async function listSidecarCollectors(base: string, headers: Record<string, string>): Promise<GraylogSidecarCollector[]> {
  try {
    return sidecarCollectorsFromList(await getJson<unknown>(`${base}/api/sidecar/collectors`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for sidecar-collector deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; os: string; collectorId: string | null; collector: GraylogSidecarCollector | null }> = []
  const applied: string[] = []

  try {
    const live = await listSidecarCollectors(base, headers)

    for (const item of items) {
      const name = asString(item.fields.name)
      const os = asString(item.fields.node_operating_system).toLowerCase()
      if (!name || !os) continue

      const body = buildSidecarCollectorBody(item.fields)
      const existing = findSidecarCollector(live, name, os)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/sidecar/collectors/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ name, os, collectorId: existing.id, collector: existing })
      } else {
        const created = await sendJson<SidecarCollectorSaveResponse>('POST', `${base}/api/sidecar/collectors`, headers, body)
        previous.push({ name, os, collectorId: created?.id ?? null, collector: null })
      }
      applied.push(`${name} (${os})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} sidecar collector(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sidecar-collector deploy failed after ${applied.length} collector(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
