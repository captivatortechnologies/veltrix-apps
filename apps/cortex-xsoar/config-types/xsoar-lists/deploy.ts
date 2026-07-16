import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient, xsoarErrorMessage, type XsoarClient } from '../../lib/xsoar'
import { extractListSpecs, type LiveList, type ListSpec } from './validate'

export interface ListRollbackEntry {
  name: string
  existed: boolean
  id: string
  prior?: { data?: string; type?: string; version?: number; tags?: string[] }
}

/**
 * Deploy XSOAR lists via the server REST API.
 *
 * A list's identity is its NAME (XSOAR sets a list's id to its name). List every
 * list (GET /lists), match on name, then upsert with POST /lists/save — carrying
 * the live id + version when updating so the save is not rejected as stale. A
 * locked list is refused (it is managed under version control in XSOAR).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, serverUrl } = built

  const specs = extractListSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ListRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listLists(client)
    const byName = new Map(existing.filter((l) => l.name).map((l) => [l.name as string, l]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.locked) {
        throw new Error(`List "${spec.name}" is locked in XSOAR and cannot be modified by the pipeline`)
      }

      if (live) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id ?? spec.name,
          prior: { data: live.data, type: live.type, version: live.version, tags: live.tags },
        })
        await saveList(client, spec, live)
      } else {
        await saveList(client, spec, null)
        rollbackState.push({ name: spec.name, existed: false, id: spec.name })
        createdNames.push(spec.name)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} list(s) to ${serverUrl}: ${deployed.join(', ')}`,
      artifacts: { serverUrl, deployedLists: deployed },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `List deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { serverUrl, deployedLists: deployed },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/** GET every list; throws on a non-OK response. */
export async function listLists(client: XsoarClient): Promise<LiveList[]> {
  const res = await client.getJson<LiveList[]>('/lists')
  if (!res.ok) throw new Error(`Failed to list lists: ${res.error ?? `HTTP ${res.status}`}`)
  return Array.isArray(res.value) ? res.value : []
}

/**
 * Upsert one list via POST /lists/save. On update, `live` supplies the id +
 * version XSOAR needs to accept the write; on create both are omitted so the
 * server derives the id from the name.
 */
export async function saveList(client: XsoarClient, spec: ListSpec, live: LiveList | null): Promise<void> {
  const body: Record<string, unknown> = {
    name: spec.name,
    data: spec.data,
    type: spec.type,
    tags: spec.tags,
  }
  if (spec.commitMessage) body.commitMessage = spec.commitMessage
  if (live) {
    body.id = live.id ?? spec.name
    if (typeof live.version === 'number') body.version = live.version
  }
  const res = await client.request('POST', '/lists/save', { body })
  if (!res.ok) throw new Error(`Failed to save list "${spec.name}": ${xsoarErrorMessage(res)}`)
}
