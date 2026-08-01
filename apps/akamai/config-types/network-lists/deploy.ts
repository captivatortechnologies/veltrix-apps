import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, NETWORK_LISTS_PATH, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import { findList, listsFromResponse, readListFields, type NetworkList } from './_shared'

/**
 * Deploy Akamai Network Lists over the Network Lists API v2 (EdgeGrid-signed):
 *   read (identity/rollback): GET  /network-list/v2/network-lists?includeElements=true
 *   create:                   POST /network-list/v2/network-lists           { name, type, description, list }
 *   update (full replace):    PUT  /network-list/v2/network-lists/{id}      { name, type, description, list, syncPoint }
 *
 * The list NAME is the stable identity used to upsert. `rollbackData.previous`
 * records, per list, the prior body (null when it did not exist) AND its
 * uniqueId — so rollback can restore the prior content or delete the one we
 * created.
 *
 * NOTE: activating a network list (STAGING/PRODUCTION) is a SEPARATE step and is
 * OUT OF SCOPE for v0.1.0 — this manages list CONTENT only. A newly created list
 * is inactive, so rollback can safely delete it.
 */

interface PriorEntry {
  name: string
  uniqueId: string | null
  /** The list body before this deploy touched it, or null when we created it. */
  prior: { name: string; type: string; description: string; list: string[] } | null
}

async function listAll(client: AkamaiClient): Promise<NetworkList[]> {
  const res = await client.request('GET', NETWORK_LISTS_PATH, { query: { includeElements: true } })
  if (!res.ok) throw new Error(`GET ${NETWORK_LISTS_PATH} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return listsFromResponse(parseJson<unknown>(res.body))
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
      const fields = readListFields(item.fields)
      if (!fields.name) continue

      const existing = findList(live, fields.name)

      if (existing && existing.uniqueId) {
        if (existing.type && existing.type !== fields.type) {
          throw new Error(
            `Network list "${fields.name}" already exists as type ${existing.type}; ` +
              `its type cannot be changed to ${fields.type}. Rename the list or match the existing type.`,
          )
        }
        const body = {
          name: fields.name,
          type: existing.type ?? fields.type,
          description: fields.description,
          list: fields.elements,
          syncPoint: existing.syncPoint ?? 0,
        }
        const res = await client.request('PUT', `${NETWORK_LISTS_PATH}/${encodeURIComponent(existing.uniqueId)}`, { body })
        if (!res.ok) throw new Error(`PUT "${fields.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({
          name: fields.name,
          uniqueId: existing.uniqueId,
          prior: {
            name: String(existing.name ?? fields.name),
            type: existing.type ?? fields.type,
            description: String(existing.description ?? ''),
            list: Array.isArray(existing.list) ? existing.list : [],
          },
        })
      } else {
        const body = { name: fields.name, type: fields.type, description: fields.description, list: fields.elements }
        const res = await client.request('POST', NETWORK_LISTS_PATH, { body })
        if (!res.ok) throw new Error(`POST "${fields.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        const created = parseJson<NetworkList>(res.body)
        previous.push({ name: fields.name, uniqueId: created?.uniqueId ?? null, prior: null })
      }
      applied.push(fields.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} network list(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network list deploy failed after ${applied.length} list(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
