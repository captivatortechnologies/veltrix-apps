import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  MISSING_CUSTOMER_ID_MESSAGE,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractSegmentGroupSpecs, type LiveSegmentGroup, type SegmentGroupSpec } from './validate'

export interface SegmentGroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: { name?: string; description?: string; enabled?: boolean }
}

/**
 * Deploy ZPA segment groups via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZPA has no upsert): list /segmentGroup, match by name,
 * then PUT an existing group or POST a new one. Unlike ZIA, ZPA changes apply
 * IMMEDIATELY — there is no activation step, so a write returning success is the
 * end of the operation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built
  if (!client.hasCustomerId) {
    return { success: false, message: MISSING_CUSTOMER_ID_MESSAGE }
  }

  const specs = extractSegmentGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: SegmentGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSegmentGroups(client)
    const byName = new Map(existing.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: { name: live.name, description: live.description ?? '', enabled: live.enabled ?? true },
        })
        const res = await client.zpa('PUT', `/segmentGroup/${live.id}`, { body: buildPayload(spec, live.id) })
        if (!res.ok) {
          throw new Error(`Failed to update segment group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zpa('POST', '/segmentGroup', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create segment group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveSegmentGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`Segment group "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ZPA segment group(s) on tenant "${vanity}": ${deployed.join(', ')}`,
      artifacts: { vanity, deployedSegmentGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Segment group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedSegmentGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZPA segment groups; throws on a non-OK response. */
export async function listSegmentGroups(client: ZscalerClient): Promise<LiveSegmentGroup[]> {
  const res = await client.zpaGetAll<LiveSegmentGroup>('/segmentGroup')
  if (!res.ok) {
    throw new Error(`Failed to list segment groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

function buildPayload(spec: SegmentGroupSpec, id?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    enabled: spec.enabled,
  }
  // PUT is replace-style — echo the id back so the record is fully specified.
  if (id != null) payload.id = id
  return payload
}
