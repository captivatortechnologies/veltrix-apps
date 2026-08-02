import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import { buildScriptBody, extractScriptSpecs, indexScriptsByName, scriptKey, type LiveScript } from './validate'

const SCRIPTS_PATH = '/v1/scripts'

export interface ScriptRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior script state, captured for a script that already existed (restored on rollback). */
  prior?: LiveScript
}

interface CreateScriptResponse {
  id?: string
  href?: string
}

/**
 * Deploy Jamf Pro scripts via the modern Jamf Pro API.
 *
 * Identity is the script `name`: list every script Jamf Pro knows about (the
 * search results already carry the full Script object — no per-item GET is
 * needed), match on the name, and either update the existing script
 * (capturing its prior full state for rollback) or create a new one. Created
 * ids are captured for rollback (delete on revert).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, apiBase } = built

  const specs = extractScriptSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ScriptRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listScripts(client, ctx.settings)
    const byName = indexScriptsByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = scriptKey(spec.name)
      const live = byName.get(key)
      const body = buildScriptBody(spec)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `${SCRIPTS_PATH}/${encodeURIComponent(live.id)}`, body)
        if (res.error) throw new Error(`Failed to update script "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.request<CreateScriptResponse>('POST', SCRIPTS_PATH, body)
        if (res.error) throw new Error(`Failed to create script "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Script "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro script(s) on ${apiBase}: ` +
        `${created.length} created, ${updated.length} updated.`,
      artifacts: { apiBase, createdScripts: created, updatedScripts: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Script deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { apiBase, createdScripts: created, updatedScripts: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List every Jamf Pro script (search results already carry full script bodies); throws on error. */
export async function listScripts(client: JamfClient, settings: Record<string, unknown>): Promise<LiveScript[]> {
  const pageSize = typeof settings.page_size === 'number' && settings.page_size > 0 ? settings.page_size : 100
  const res = await client.listAll<LiveScript>(SCRIPTS_PATH, pageSize)
  if (res.error) throw new Error(`Failed to list Jamf Pro scripts: ${res.error}`)
  return res.nodes
}
