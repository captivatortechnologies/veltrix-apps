import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  buildItemBody,
  extractItemValue,
  extractListSpecs,
  type ListSpec,
  type LiveList,
  type LiveListItem,
} from './validate'

export interface ListRollbackEntry {
  name: string
  kind: string
  existed: boolean
  id?: string
  /** Prior metadata/items for a list that already existed (for restore). */
  priorDescription?: string
  priorItems?: string[]
}

/**
 * Deploy Cloudflare Lists via the API (account-scoped).
 *
 * Identity is the list `name`: list /rules/lists, match on the name, then either
 * PATCH an existing list's description or POST a new one, and in both cases
 * replace its items (PUT /rules/lists/{id}/items) with the canvas contents. The
 * items are a full replacement so re-runs converge on exactly what is declared.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  // Lists are account-scoped — bail before mutating anything if no account is available.
  if (!(await client.hasAccount())) {
    return { success: false, message: MISSING_ACCOUNT_MESSAGE }
  }

  const specs = extractListSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ListRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listLists(client)
    const byName = new Map(existing.filter((l) => l.name).map((l) => [l.name as string, l]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.id) {
        // Capture prior description + items before overwriting so rollback can restore them.
        const priorItems = (await listItems(client, live.id))
          .map((it) => extractItemValue(spec.kind, it))
          .filter((v): v is string => v !== null)
        rollbackState.push({
          name: spec.name,
          kind: spec.kind,
          existed: true,
          id: live.id,
          priorDescription: live.description ?? '',
          priorItems,
        })

        const patch = await client.account('PATCH', `/rules/lists/${live.id}`, { body: { description: spec.description } })
        if (!patch.ok) throw new Error(`Failed to update list "${spec.name}": ${cloudflareErrorMessage(patch)}`)
        await replaceItems(client, live.id, spec)
      } else {
        const create = await client.account('POST', '/rules/lists', {
          body: { name: spec.name, kind: spec.kind, description: spec.description },
        })
        if (!create.ok) throw new Error(`Failed to create list "${spec.name}": ${cloudflareErrorMessage(create)}`)
        const created = cloudflareResult<LiveList>(create)
        if (!created?.id) throw new Error(`List "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, kind: spec.kind, existed: false, id: created.id })
        createdIds.push(created.id)
        await replaceItems(client, created.id, spec)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} list(s): ${deployed.join(', ')}`,
      artifacts: { deployedLists: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `List deployment failed after ${deployed.length} of ${specs.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployedLists: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Cloudflare Lists in the account; throws on a non-OK response. */
export async function listLists(client: CloudflareClient): Promise<LiveList[]> {
  const res = await client.accountGetAll<LiveList>('/rules/lists')
  if (!res.ok) {
    throw new Error(`Failed to list Cloudflare lists: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all items in a single Cloudflare List; throws on a non-OK response. */
export async function listItems(client: CloudflareClient, id: string): Promise<LiveListItem[]> {
  const res = await client.accountGetAll<LiveListItem>(`/rules/lists/${id}/items`)
  if (!res.ok) {
    throw new Error(`Failed to list items for list "${id}": ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** Replace a list's items wholesale (PUT) with the spec's declared contents. */
async function replaceItems(client: CloudflareClient, id: string, spec: ListSpec): Promise<void> {
  const body = spec.items.map((value) => buildItemBody(spec.kind, value))
  const res = await client.account('PUT', `/rules/lists/${id}/items`, { body })
  if (!res.ok) throw new Error(`Failed to set items for list "${spec.name}": ${cloudflareErrorMessage(res)}`)
}
