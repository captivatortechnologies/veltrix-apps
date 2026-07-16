import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import { extractTagSpecs, parseJsonObject, tagKey, type LiveTag, type TagSpec } from './validate'

export interface TagRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  prior?: LiveTag
}

/**
 * Deploy Rapid7 InsightVM tags via the Console API.
 *
 * Identity is the (name, type) natural key: list /tags, match on the key, then
 * PUT an existing tag by id or POST a new one. Built-in (source: built-in) tags
 * are protected — never modified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: TagRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listTags(client)
    const byKey = new Map(
      existing
        .filter((t) => t.name && t.type)
        .map((t) => [tagKey({ name: t.name as string, type: t.type as string }), t]),
    )

    for (const spec of specs) {
      const label = `${spec.name} (${spec.type})`
      const key = tagKey(spec)
      const live = byKey.get(key)

      if (live && live.source === 'built-in') {
        throw new Error(`Tag "${label}" is a built-in tag and cannot be modified`)
      }

      if (live && live.id != null) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/tags/${live.id}`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to update tag "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/tags', { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create tag "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Tag "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} tag(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedTags: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tag deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedTags: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all tags; throws on a non-OK response. */
export async function listTags(client: InsightVMClient): Promise<LiveTag[]> {
  const res = await client.getAll<LiveTag>('/tags')
  if (!res.ok) {
    throw new Error(`Failed to list tags: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

function buildBody(spec: TagSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, type: spec.type }
  if (spec.color) body.color = spec.color
  if (spec.type === 'criticality' && spec.riskModifier !== undefined) body.riskModifier = spec.riskModifier
  const criteria = parseJsonObject(spec.searchCriteriaJson)
  if (criteria.value && Object.keys(criteria.value).length > 0) body.searchCriteria = criteria.value
  return body
}
