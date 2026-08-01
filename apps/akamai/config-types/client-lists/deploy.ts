import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, CLIENT_LISTS_PATH, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import {
  clientListsFromResponse,
  diffValues,
  findClientList,
  readClientListFields,
  toItemPayload,
  valuesFromList,
  type ClientList,
} from './_shared'

/**
 * Deploy Akamai Client Lists over the Client Lists API v1 (EdgeGrid-signed):
 *   read (identity/rollback): GET    /client-list/v1/lists?includeItems=true
 *   create:                   POST   /client-list/v1/lists            { contractId, groupId, name, type, notes, tags, items }
 *   update (details):         PUT    /client-list/v1/lists/{id}       { name, notes, tags }
 *   sync entries:             POST   /client-list/v1/lists/{id}/items { append, update, delete }
 *
 * The list NAME is the stable identity used to upsert. Entries are reconciled to
 * a FULL REPLACE (append the missing, delete the extra) via the batch items
 * endpoint. `rollbackData.previous` records, per list, the prior details + entry
 * values (null when we created it) AND its listId — so rollback can restore the
 * prior content or delete the one we created.
 *
 * NOTE: this manages list CONTENT only. A newly created client list is INACTIVE,
 * so rollback can safely delete it. Activating a client list (STAGING/PRODUCTION,
 * POST /client-list/v1/lists/{id}/activations) is a SEPARATE step and is not
 * performed here — see the CHANGELOG.
 */

interface PriorEntry {
  name: string
  listId: string | null
  /** The list state before this deploy touched it, or null when we created it. */
  prior: { name: string; notes: string; tags: string[]; values: string[] } | null
}

async function listAll(client: AkamaiClient): Promise<ClientList[]> {
  const res = await client.request('GET', CLIENT_LISTS_PATH, { query: { includeItems: true } })
  if (!res.ok) throw new Error(`GET ${CLIENT_LISTS_PATH} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return clientListsFromResponse(parseJson<unknown>(res.body))
}

/** Reconcile a live list's entries to the desired values (full replace) via the batch endpoint. */
async function syncEntries(client: AkamaiClient, listId: string, desired: string[], current: string[]): Promise<boolean> {
  const { append, remove } = diffValues(desired, current)
  if (append.length === 0 && remove.length === 0) return false
  const body = { append: toItemPayload(append), update: [], delete: toItemPayload(remove) }
  const res = await client.request('POST', `${CLIENT_LISTS_PATH}/${encodeURIComponent(listId)}/items`, { body })
  if (!res.ok) throw new Error(`sync entries for "${listId}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return true
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    const live = await listAll(client)

    for (const item of items) {
      const fields = readClientListFields(item.fields)
      if (!fields.name) continue

      const existing = findClientList(live, fields.name)

      if (existing && existing.listId) {
        if (existing.type && existing.type !== fields.type) {
          throw new Error(
            `Client list "${fields.name}" already exists as type ${existing.type}; its type cannot ` +
              `be changed to ${fields.type}. Rename the list or match the existing type.`,
          )
        }
        const priorValues = valuesFromList(existing)
        const detailsBody = { name: fields.name, notes: fields.notes, tags: fields.tags }
        const res = await client.request('PUT', `${CLIENT_LISTS_PATH}/${encodeURIComponent(existing.listId)}`, { body: detailsBody })
        if (!res.ok) throw new Error(`PUT "${fields.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)

        await syncEntries(client, existing.listId, fields.values, priorValues)

        previous.push({
          name: fields.name,
          listId: existing.listId,
          prior: {
            name: String(existing.name ?? fields.name),
            notes: String(existing.notes ?? ''),
            tags: Array.isArray(existing.tags) ? existing.tags : [],
            values: priorValues,
          },
        })
      } else {
        if (!fields.contractId || fields.groupId == null) {
          throw new Error(
            `Client list "${fields.name}" does not exist yet, so it must be created — that requires ` +
              'both a Contract ID and a numeric Group ID. Fill both in.',
          )
        }
        const body = {
          contractId: fields.contractId,
          groupId: fields.groupId,
          name: fields.name,
          type: fields.type,
          notes: fields.notes,
          tags: fields.tags,
          items: toItemPayload(fields.values),
        }
        const res = await client.request('POST', CLIENT_LISTS_PATH, { body })
        if (!res.ok) throw new Error(`POST "${fields.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        const created = parseJson<ClientList>(res.body)
        previous.push({ name: fields.name, listId: created?.listId ?? null, prior: null })
      }
      applied.push(fields.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} client list(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Client list deploy failed after ${applied.length} list(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
