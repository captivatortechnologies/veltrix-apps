import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigClient, type SysdigList } from '../../lib/sysdigApi'
import { buildListBody, findListByName, normalizeEnabled } from './_shared'

/**
 * Deploy Sysdig Secure custom Falco lists over the REST API:
 *   find:    GET    /api/secure/falco/lists/groups?name=<name>
 *   create:  POST   /api/secure/falco/lists
 *   update:  PUT    /api/secure/falco/lists/<id>   (carries the live id + version)
 *   remove:  DELETE /api/secure/falco/lists/<id>   (for a disabled list)
 *
 * The list name is the stable identity used to upsert. `enabled: false` is
 * modeled as "absent from the custom rule library": a disabled list that exists
 * is deleted (mirroring the Falco-rules config type). rollbackData records, per
 * list, the action taken and the prior body so rollback can restore/remove.
 */
type ListAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: ListAction
  listId: number | null
  /** The list body BEFORE this deploy (null when it did not exist). */
  prior: SysdigList | null
}

/** Look up a list by name (best-effort — a lookup error is treated as "not found"). */
async function findLive(client: SysdigClient, name: string): Promise<SysdigList | null> {
  try {
    return findListByName(await client.listFalcoListsByName(name), name)
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const enabled = normalizeEnabled(item.fields.enabled)

      const existing = await findLive(client, name)
      const existingId = typeof existing?.id === 'number' ? existing.id : null

      if (!enabled) {
        if (existing && existingId != null) {
          await client.deleteFalcoList(existingId)
          previous.push({ name, action: 'deleted', listId: existingId, prior: existing })
        } else {
          previous.push({ name, action: 'noop', listId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const body = buildListBody(item.fields)
      if (existing && existingId != null) {
        await client.updateFalcoList(existingId, { ...body, id: existingId, version: existing.version })
        previous.push({ name, action: 'updated', listId: existingId, prior: existing })
      } else {
        const created = await client.createFalcoList(body)
        const newId = typeof created?.id === 'number' ? created.id : null
        previous.push({ name, action: 'created', listId: newId, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Falco list(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Falco list deploy failed after ${applied.length} list(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
