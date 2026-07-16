import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import {
  assetGroupKey,
  extractAssetGroupSpecs,
  parseJsonObject,
  type AssetGroupSpec,
  type LiveAssetGroup,
} from './validate'

export interface AssetGroupRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  prior?: LiveAssetGroup
}

/**
 * Deploy Rapid7 InsightVM asset groups via the Console API.
 *
 * Identity is the name natural key: list /asset_groups, match on the name, then
 * PUT an existing group by id or POST a new one. A dynamic group carries its
 * parsed search criteria; a static group is populated by tags/manual assignment.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractAssetGroupSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: AssetGroupRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listAssetGroups(client)
    const byKey = new Map(
      existing.filter((g) => g.name).map((g) => [assetGroupKey({ name: g.name as string }), g]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = assetGroupKey(spec)
      const live = byKey.get(key)

      if (live && live.id != null) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/asset_groups/${live.id}`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to update asset group "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/asset_groups', { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create asset group "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Asset group "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} asset group(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedAssetGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Asset group deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedAssetGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all asset groups; throws on a non-OK response. */
export async function listAssetGroups(client: InsightVMClient): Promise<LiveAssetGroup[]> {
  const res = await client.getAll<LiveAssetGroup>('/asset_groups')
  if (!res.ok) {
    throw new Error(
      `Failed to list asset groups: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

export function buildBody(spec: AssetGroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, description: spec.description, type: spec.type }
  if (spec.type === 'dynamic') {
    const criteria = parseJsonObject(spec.searchCriteriaJson)
    if (criteria.value && Object.keys(criteria.value).length > 0) body.searchCriteria = criteria.value
  }
  return body
}
