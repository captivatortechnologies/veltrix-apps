import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient, type KandjiClient } from '../../lib/kandjiApi'
import {
  buildCustomScriptBody,
  customScriptKey,
  extractCustomScriptSpecs,
  indexCustomScriptsByName,
  type LiveCustomScript,
} from './validate'

const CUSTOM_SCRIPTS_PATH = '/api/v1/library/custom-scripts'

export interface CustomScriptRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveCustomScript
}

/** List every Custom Script Library item, following pagination to completion. */
export async function listCustomScripts(client: KandjiClient): Promise<LiveCustomScript[]> {
  const res = await client.listAll<LiveCustomScript>(CUSTOM_SCRIPTS_PATH)
  if (res.error) throw new Error(`Failed to list Kandji Custom Scripts: ${res.error}`)
  return res.nodes
}

/**
 * Deploy Kandji Custom Scripts via the tenant API: list, match by name,
 * create missing / update existing (capturing prior state for rollback).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractCustomScriptSpecs(ctx.canvas).filter((s) => s.name && s.script)
  const rollbackState: CustomScriptRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listCustomScripts(client)
    const byName = indexCustomScriptsByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = customScriptKey(spec.name)
      const live = byName.get(key)
      const body = buildCustomScriptBody(spec)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PATCH', `${CUSTOM_SCRIPTS_PATH}/${encodeURIComponent(live.id)}`, { body })
        if (res.error) throw new Error(`Failed to update Custom Script "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.request<LiveCustomScript>('POST', CUSTOM_SCRIPTS_PATH, { body })
        if (res.error) throw new Error(`Failed to create Custom Script "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Custom Script "${label}" was created but Kandji returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} Kandji Custom Script(s) on ${baseUrl}: ${created.length} created, ${updated.length} updated.`,
      artifacts: { baseUrl, createdCustomScripts: created, updatedCustomScripts: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom Script deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, createdCustomScripts: created, updatedCustomScripts: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}
