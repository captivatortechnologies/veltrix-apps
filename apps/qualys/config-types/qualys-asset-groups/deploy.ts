import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qualysErrorMessage,
  qualysReturnId,
  qualysWriteError,
  xmlText,
  xmlTextList,
  type QualysClient,
  type QualysParams,
} from '../../lib/qualys'
import { assetGroupKey, extractAssetGroupSpecs, type AssetGroupSpec, type LiveAssetGroup } from './validate'

export const ASSET_GROUP_PATH = '/api/2.0/fo/asset/group/'

export interface AssetGroupRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveAssetGroup
}

/**
 * Deploy Qualys asset groups via the classic v2 API.
 *
 * Identity is the title natural key: list asset groups, match on the title, then
 * edit an existing group by id or add a new one. The new group's id is read from
 * the SIMPLE_RETURN so rollback can delete it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractAssetGroupSpecs(ctx.canvas).filter((s) => s.title)
  const rollbackState: AssetGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listAssetGroups(client)
    const byKey = new Map(existing.map((g) => [assetGroupKey(g), g]))

    for (const spec of specs) {
      const label = spec.title
      const key = assetGroupKey(spec)
      const live = byKey.get(key)

      if (live) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.post(ASSET_GROUP_PATH, buildEditParams(spec, live.id))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to update asset group "${label}": ${failed}`)
      } else {
        const res = await client.post(ASSET_GROUP_PATH, buildAddParams(spec))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to create asset group "${label}": ${failed}`)
        const newId = qualysReturnId(res.body)
        if (!newId) throw new Error(`Asset group "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: newId })
        createdIds.push(newId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} asset group(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedAssetGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Asset group deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedAssetGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all asset groups; throws on a non-OK response. */
export async function listAssetGroups(client: QualysClient): Promise<LiveAssetGroup[]> {
  const res = await client.list(ASSET_GROUP_PATH, { show_attributes: 'ALL' }, 'ASSET_GROUP')
  if (!res.ok) {
    throw new Error(`Failed to list asset groups: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.blocks.map(parseAssetGroupBlock).filter((g) => g.id && g.title)
}

/** Parse one <ASSET_GROUP> block into a LiveAssetGroup. */
export function parseAssetGroupBlock(block: string): LiveAssetGroup {
  const ipSet = block.match(/<IP_SET>([\s\S]*?)<\/IP_SET>/i)?.[1] ?? ''
  const ips = [...xmlTextList(ipSet, 'IP'), ...xmlTextList(ipSet, 'IP_RANGE')].filter(Boolean)
  return {
    id: xmlText(block, 'ID'),
    title: xmlText(block, 'TITLE'),
    comments: xmlText(block, 'COMMENTS'),
    businessImpact: xmlText(block, 'BUSINESS_IMPACT').toLowerCase(),
    networkId: xmlText(block, 'NETWORK_ID'),
    ips,
  }
}

/** Normalize a comma/whitespace-separated IP list into a comma-separated string. */
export function normalizeIps(raw: string): string {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',')
}

export function buildAddParams(spec: AssetGroupSpec): QualysParams {
  const params: QualysParams = { action: 'add', title: spec.title }
  if (spec.comments) params.comments = spec.comments
  if (spec.division) params.division = spec.division
  if (spec.location) params.location = spec.location
  if (spec.businessImpact) params.business_impact = spec.businessImpact
  if (spec.networkId) params.network_id = spec.networkId
  const ips = normalizeIps(spec.ips)
  if (ips) params.ips = ips
  return params
}

export function buildEditParams(spec: AssetGroupSpec, id: string): QualysParams {
  // set_* overwrites the field to the declared value; title/comments/division/
  // location are always reconciled. business_impact / ips are only touched when
  // declared so a blank field does not clobber values managed elsewhere.
  const params: QualysParams = {
    action: 'edit',
    id,
    set_title: spec.title,
    set_comments: spec.comments,
    set_division: spec.division,
    set_location: spec.location,
  }
  if (spec.businessImpact) params.set_business_impact = spec.businessImpact
  const ips = normalizeIps(spec.ips)
  if (ips) params.set_ips = ips
  return params
}
