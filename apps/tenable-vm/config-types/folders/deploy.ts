import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractFolderSpecs, type FolderSpec, type LiveFolder } from './validate'

export interface FolderRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: Partial<Pick<LiveFolder, 'name'>>
}

/**
 * Deploy scan folders to a Tenable tenant via the Folders API.
 *
 * A folder's logical identity is its NAME; Tenable assigns the numeric id on
 * creation. For each declared folder:
 *   - GET    /folders          — list, then match on name
 *   - PUT    /folders/{id}      — converge an existing folder (capture prior name)
 *   - POST   /folders           — create a missing folder (capture the new id)
 *
 * Because a folder's only managed field IS its name (the identity we match on),
 * the PUT on an already-present folder is a no-op that simply re-asserts the
 * name; recording it with existed=true is what tells rollback NOT to delete a
 * folder that pre-existed. System folders ("My Scans", "Trash", type=system)
 * are never touched — validate rejects those names and this guards on the live
 * type as defence in depth.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractFolderSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FolderRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.name

      const existing = await findFolder(client, spec.name)

      // Never target Tenable's system folders — they cannot be renamed or
      // deleted. Refuse rather than issue a PUT that Tenable would reject.
      if (existing && existing.type === 'system') {
        throw new Error(`Folder "${label}" is a Tenable system folder and cannot be managed`)
      }

      if (existing && typeof existing.id === 'number') {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: { name: existing.name },
        })

        const res = await client.request('PUT', `/folders/${existing.id}`, {
          body: buildFolderPayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update folder "${label}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/folders', {
          body: buildFolderPayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create folder "${label}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveFolder>(res.body)
        if (typeof created?.id !== 'number') {
          throw new Error(`Folder "${label}" was created but the API returned no folder id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} folder(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedFolders: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Folder deployment failed after ${deployed.length} of ${specs.length} folder(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedFolders: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/**
 * Find a folder by its name; null when absent. A plain GET /folders returns the
 * full folder list (custom + system) for the tenant.
 */
export async function findFolder(client: TenableClient, name: string): Promise<LiveFolder | null> {
  const res = await client.request('GET', '/folders')
  if (!res.ok) {
    throw new Error(`Failed to list folders while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const folders = parseJson<{ folders?: LiveFolder[] }>(res.body)?.folders ?? []
  // Match the name exactly — Tenable stores folder names as literal strings.
  return folders.find((f) => f.name === name) ?? null
}

function buildFolderPayload(spec: FolderSpec): Record<string, unknown> {
  // The Folders API accepts a single field on create and rename: { name }.
  return { name: spec.name }
}
