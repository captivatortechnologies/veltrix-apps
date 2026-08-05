import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import {
  extractOverrideSpecs,
  liveOverrideKey,
  overrideKey,
  overrideLabel,
  type LiveOverride,
  type OverrideSpec,
} from './validate'

export interface OverrideRollbackEntry {
  key: string
  label: string
  /** true when the override already existed live (skipped); false when we created it. */
  existed: boolean
  id?: number
}

/**
 * Deploy Rapid7 InsightVM policy overrides via the Console API.
 *
 * Identity is the (rule, scope type, asset) natural key. This config type is
 * CREATE/skip only — the console offers no in-place update for an override
 * (only its expiration and review status can be changed, which are workflow
 * actions this app does not manage): list /policy_overrides, match on the key,
 * POST a new override when absent, and leave an existing one untouched. Only
 * created overrides are recorded for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractOverrideSpecs(ctx.canvas).filter((s) => s.ruleId !== undefined && s.newResult)
  const rollbackState: OverrideRollbackEntry[] = []
  const createdIds: number[] = []
  const created: string[] = []
  const skipped: string[] = []

  try {
    const existing = await listOverrides(client)
    const byKey = new Map<string, LiveOverride>()
    for (const live of existing) {
      const key = liveOverrideKey(live)
      if (key && !byKey.has(key)) byKey.set(key, live)
    }

    for (const spec of specs) {
      const label = overrideLabel(spec)
      const key = overrideKey({ ruleId: spec.ruleId as number, scopeType: spec.scopeType, assetId: spec.assetId })
      const live = byKey.get(key)

      if (live) {
        // Already present — CREATE/skip only, so this is a no-op (no update path).
        rollbackState.push({ key, label, existed: true, id: typeof live.id === 'number' ? live.id : undefined })
        skipped.push(label)
        continue
      }

      const res = await client.request('POST', '/policy_overrides', { body: buildBody(spec) })
      if (!res.ok) throw new Error(`Failed to create policy override for ${label}: ${insightVMErrorMessage(res)}`)
      const createdBody = parseJson<{ id?: number }>(res.body)
      if (createdBody?.id == null) throw new Error(`Policy override for ${label} was created but the API returned no id`)
      rollbackState.push({ key, label, existed: false, id: createdBody.id })
      createdIds.push(createdBody.id)
      created.push(label)
    }

    const summary = `Created ${created.length}, skipped ${skipped.length} existing policy override(s) on ${consoleUrl}`
    return {
      success: true,
      message: created.length ? `${summary}: ${created.join(', ')}` : summary,
      artifacts: { consoleUrl, createdOverrides: created, skippedOverrides: skipped },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy override deployment failed after ${created.length + skipped.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, createdOverrides: created, skippedOverrides: skipped },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all policy overrides; throws on a non-OK response. */
export async function listOverrides(client: InsightVMClient): Promise<LiveOverride[]> {
  const res = await client.getAll<LiveOverride>('/policy_overrides')
  if (!res.ok) {
    throw new Error(
      `Failed to list policy overrides: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/**
 * Build the /policy_overrides request body. `asset` is omitted for an
 * all-assets override; `original_result` and `expires` are omitted when blank.
 */
function buildBody(spec: OverrideSpec): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    type: spec.scopeType,
    rule: spec.ruleId,
    new_result: spec.newResult,
  }
  if (spec.scopeType !== 'all-assets' && spec.assetId !== undefined) scope.asset = spec.assetId
  if (spec.originalResult) scope.original_result = spec.originalResult

  const body: Record<string, unknown> = { scope }
  if (spec.expires) body.expires = spec.expires
  return body
}
