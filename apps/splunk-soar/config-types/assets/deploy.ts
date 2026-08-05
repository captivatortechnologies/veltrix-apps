import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, listAll, sendJson } from '../../lib/soarApi'
import { buildAssetSpec, findAssetByName, type SoarAsset } from './_shared'

/**
 * Deploy assets over the SOAR REST API (443):
 *   read (upsert lookup): GET  /rest/asset?page_size=0 → find the live asset by name
 *   create:                POST /rest/asset             with the full body (incl. configuration)
 *   update:                POST /rest/asset/<id>          (full replace — see _shared.ts)
 *
 * rollbackData records, per asset, its numeric id and — ONLY for a newly
 * created asset — nothing else (there is no prior state to restore, and
 * `configuration` was never captured so it can never be re-sent safely; see
 * rollback.ts for why an UPDATED asset's rollback is a deliberate no-op).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for asset deployment' }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; assetId: number | string | null; existedBefore: boolean }> = []
  const applied: string[] = []

  try {
    const live = await listAll<SoarAsset>(base, headers, 'asset')

    for (const item of items) {
      const spec = buildAssetSpec(item.fields)
      if (!spec.id) continue
      if (spec.error || !spec.nonSecretBody) {
        return {
          success: false,
          message: `Asset ${spec.id}: ${spec.error ?? 'invalid configuration'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const body = { ...spec.nonSecretBody, configuration: spec.configuration }
      const existing = findAssetByName(live, spec.id)
      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/rest/asset/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name: spec.id, assetId: existing.id, existedBefore: true })
      } else {
        const created = await sendJson<{ id?: number | string }>('POST', `${base}/rest/asset`, headers, body)
        previous.push({ name: spec.id, assetId: created?.id ?? null, existedBefore: false })
      }
      applied.push(spec.id)
    }

    return {
      success: true,
      message: `Applied ${applied.length} asset(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Asset deploy failed after ${applied.length} asset(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
