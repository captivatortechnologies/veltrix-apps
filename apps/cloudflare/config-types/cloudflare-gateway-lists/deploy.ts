import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractGatewayListSpecs,
  gatewayListKey,
  type GatewayListSpec,
  type LiveGatewayList,
} from './validate'

export interface GatewayListRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveGatewayList
}

/**
 * Deploy Cloudflare Zero Trust Gateway lists via the API (account-scoped).
 *
 * Identity is the list name: list /gateway/lists, match on the name, then PATCH
 * an existing list by id or POST a new one. Cloudflare assigns the server id; we
 * key on the name so re-runs update rather than duplicate. The list type is set
 * once at creation and is immutable, so updates carry only name/description/items.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  if (!(await client.hasAccount())) {
    return { success: false, message: MISSING_ACCOUNT_MESSAGE }
  }

  const specs = extractGatewayListSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: GatewayListRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listGatewayLists(client)
    const byKey = new Map(existing.filter((l) => l.name).map((l) => [gatewayListKey(l.name as string), l]))

    for (const spec of specs) {
      const label = spec.name
      const key = gatewayListKey(spec.name)
      const live = byKey.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.account('PATCH', `/gateway/lists/${live.id}`, { body: buildUpdatePayload(spec) })
        if (!res.ok) throw new Error(`Failed to update Gateway list "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', '/gateway/lists', { body: buildCreatePayload(spec) })
        if (!res.ok) throw new Error(`Failed to create Gateway list "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LiveGatewayList>(res)
        if (!created?.id) throw new Error(`Gateway list "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Gateway list(s) for account behind "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedLists: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Gateway list deployment failed after ${deployed.length} of ${specs.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedLists: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Gateway lists in the account; throws on a non-OK response. */
export async function listGatewayLists(client: CloudflareClient): Promise<LiveGatewayList[]> {
  const res = await client.accountGetAll<LiveGatewayList>('/gateway/lists')
  if (!res.ok) {
    throw new Error(
      `Failed to list Gateway lists: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Map the textarea lines into the Cloudflare `items` array of `{ value }` objects. */
function toItems(spec: GatewayListSpec): Array<{ value: string }> {
  return spec.items.map((value) => ({ value }))
}

function buildCreatePayload(spec: GatewayListSpec): Record<string, unknown> {
  return {
    name: spec.name,
    type: spec.type,
    description: spec.description,
    items: toItems(spec),
  }
}

function buildUpdatePayload(spec: GatewayListSpec): Record<string, unknown> {
  // `type` is immutable on an existing Gateway list — carry only mutable fields.
  return {
    name: spec.name,
    description: spec.description,
    items: toItems(spec),
  }
}
