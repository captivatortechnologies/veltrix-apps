import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { priorServerId, readPriorRollback } from '../../lib/reconcile'
import {
  buildCustomTagRuleBody,
  createIdFromEnvelope,
  tagRuleFromEnvelope,
  type OrcaTagRule,
  type TagRuleRollbackData,
  type TagRuleRollbackEntry,
} from './_shared'

/**
 * Deploy Orca custom tag rules over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   read (update/restore): GET  /api/custom_tags/{id}
 *   create:                POST /api/custom_tags            -> { data: { tags_rule_id } }
 *   update:                PUT  /api/custom_tags/{id}
 *
 * Orca has no documented "list custom tag rules" endpoint, so identity is the
 * rule id this app ASSIGNS on create and PERSISTS in rollbackData — recovered
 * on the next deploy by the stable canvas item id first (so a rename updates
 * the same rule) then by name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback<OrcaTagRule>(ctx)

  const previous: TagRuleRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const bodyResult = buildCustomTagRuleBody(item.fields)
      if (!bodyResult.ok) throw new Error(`custom tag rule "${name}": ${bodyResult.error}`)

      const knownId = priorServerId(previousData.previous, itemId, name)
      const prior = knownId ? await readTagRule(client, knownId) : null

      if (knownId && prior) {
        const res = await client.request<unknown>('PUT', `/api/custom_tags/${encodeURIComponent(knownId)}`, bodyResult.body)
        if (res.error) throw new Error(`update custom tag rule "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, serverId: knownId, existed: true, prior })
      } else {
        const res = await client.request<unknown>('POST', '/api/custom_tags', bodyResult.body)
        if (res.error) throw new Error(`create custom tag rule "${name}" failed: ${res.error}`)
        const newId = createIdFromEnvelope(res.data)
        previous.push({ itemId, name, serverId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom tag rule(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies TagRuleRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom tag rule deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies TagRuleRollbackData,
    }
  }
}

/** GET one tag rule by id, returning its body or null when gone / unreadable. */
async function readTagRule(client: OrcaClient, id: string): Promise<OrcaTagRule | null> {
  const res = await client.request<unknown>('GET', `/api/custom_tags/${encodeURIComponent(id)}`)
  if (res.error) return null
  return tagRuleFromEnvelope(res.data)
}
