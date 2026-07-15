import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractLabelSpecs, type LabelSpec, type LiveLabel } from './validate'

export interface LabelRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: { name?: string; description?: string }
}

/**
 * Deploy ZIA rule labels via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /ruleLabels, match by name,
 * then PUT an existing label or POST a new one. ZIA STAGES every write — nothing
 * takes effect until activation — so this writes all labels, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractLabelSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: LabelRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listLabels(client)
    const byName = new Map(existing.filter((l) => l.name).map((l) => [l.name as string, l]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: { name: live.name, description: live.description ?? '' },
        })
        const res = await client.zia('PUT', `/ruleLabels/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update rule label "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/ruleLabels', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create rule label "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveLabel>(res.body)
        if (created?.id == null) {
          throw new Error(`Rule label "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA rule label(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedLabels: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA rule label(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedLabels: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Rule label deployment failed after ${deployed.length} of ${specs.length} label(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedLabels: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA rule labels; throws on a non-OK response. */
export async function listLabels(client: ZscalerClient): Promise<LiveLabel[]> {
  const res = await client.ziaGetAll<LiveLabel>('/ruleLabels')
  if (!res.ok) {
    throw new Error(`Failed to list rule labels: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** Find a rule label by name; null when absent. */
export async function findLabel(client: ZscalerClient, name: string): Promise<LiveLabel | null> {
  const all = await listLabels(client)
  return all.find((l) => l.name === name) ?? null
}

function buildPayload(spec: LabelSpec): Record<string, unknown> {
  // description always sent (even empty) so clearing it converges the live label.
  return { name: spec.name, description: spec.description ?? '' }
}
