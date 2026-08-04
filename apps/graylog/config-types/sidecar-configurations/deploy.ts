import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import {
  buildSidecarConfigBody,
  sidecarConfigSummariesFromList,
  findSidecarConfigSummary,
  resolveCollectorId,
  type GraylogSidecarConfig,
  type GraylogSidecarConfigSummary,
} from './_shared'

/**
 * Deploy Graylog Sidecar configurations over the REST API:
 *   resolve: GET /api/sidecar/collectors                        → collector_name(+os) → id
 *   read (rollback): GET /api/sidecar/configurations              → find the live config by name (summary only)
 *                     GET /api/sidecar/configurations/{id}         → full config (with template) for the snapshot
 *   create:          POST /api/sidecar/configurations              → Configuration { id, ... }
 *   update:          PUT  /api/sidecar/configurations/{id}         → Configuration
 *
 * The configuration NAME is the stable identity used to upsert. An
 * unresolvable collector name fails that item's deploy loudly. rollbackData
 * records, per configuration, the prior FULL configuration (null when it did
 * not exist) AND its id — so rollback can restore the prior template/tags or
 * delete the one we created.
 */
interface SidecarConfigSaveResponse {
  id?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for sidecar-configuration deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; configId: string | null; config: GraylogSidecarConfig | null }> = []
  const applied: string[] = []

  try {
    let liveSummaries: GraylogSidecarConfigSummary[]
    try {
      liveSummaries = sidecarConfigSummariesFromList(await getJson<unknown>(`${base}/api/sidecar/configurations`, headers))
    } catch {
      liveSummaries = []
    }

    for (const item of items) {
      const name = asString(item.fields.name)
      if (!name) continue

      const collectorName = asString(item.fields.collector_name)
      const collectorOs = asString(item.fields.collector_os)
      const collectorId = await resolveCollectorId(base, headers, collectorName, collectorOs)
      if (!collectorId) throw new Error(`Sidecar configuration "${name}": collector "${collectorName}" was not found.`)

      const { body, error } = buildSidecarConfigBody(item.fields, collectorId)
      if (error || !body) throw new Error(`Sidecar configuration "${name}": ${error ?? 'could not build request body'}`)

      const existingSummary = findSidecarConfigSummary(liveSummaries, name)
      if (existingSummary?.id) {
        let full: GraylogSidecarConfig | null = null
        try {
          full = await getJson<GraylogSidecarConfig>(`${base}/api/sidecar/configurations/${encodeURIComponent(existingSummary.id)}`, headers)
        } catch {
          full = null
        }
        await sendJson('PUT', `${base}/api/sidecar/configurations/${encodeURIComponent(existingSummary.id)}`, headers, body)
        previous.push({ name, configId: existingSummary.id, config: full })
      } else {
        const created = await sendJson<SidecarConfigSaveResponse>('POST', `${base}/api/sidecar/configurations`, headers, body)
        previous.push({ name, configId: created?.id ?? null, config: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} sidecar configuration(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sidecar-configuration deploy failed after ${applied.length} configuration(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
