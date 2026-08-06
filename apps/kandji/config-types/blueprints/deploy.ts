import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient, type KandjiClient } from '../../lib/kandjiApi'
import {
  buildBlueprintCreateBody,
  buildBlueprintUpdateBody,
  blueprintKey,
  extractBlueprintSpecs,
  indexBlueprintsByName,
  type LiveBlueprint,
} from './validate'

const BLUEPRINTS_PATH = '/api/v1/blueprints'

export interface BlueprintRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveBlueprint
}

/** List every Blueprint in the tenant, following pagination to completion. */
export async function listBlueprints(client: KandjiClient): Promise<LiveBlueprint[]> {
  const res = await client.listAll<LiveBlueprint>(BLUEPRINTS_PATH, { limit: 100 })
  if (res.error) throw new Error(`Failed to list Kandji Blueprints: ${res.error}`)
  return res.nodes
}

/**
 * Deploy Kandji Blueprints via the tenant API: list, match by name, create
 * missing / update existing (capturing prior state for rollback). `type` is
 * only ever sent on create — see validate.ts.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractBlueprintSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: BlueprintRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listBlueprints(client)
    const byName = indexBlueprintsByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = blueprintKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.requestUrlEncoded(
          'PATCH',
          `${BLUEPRINTS_PATH}/${encodeURIComponent(live.id)}`,
          buildBlueprintUpdateBody(spec),
        )
        if (res.error) throw new Error(`Failed to update Blueprint "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.requestUrlEncoded<LiveBlueprint>(
          'POST',
          BLUEPRINTS_PATH,
          buildBlueprintCreateBody(spec),
        )
        if (res.error) throw new Error(`Failed to create Blueprint "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Blueprint "${label}" was created but Kandji returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} Kandji Blueprint(s) on ${baseUrl}: ${created.length} created, ${updated.length} updated.`,
      artifacts: { baseUrl, createdBlueprints: created, updatedBlueprints: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Blueprint deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, createdBlueprints: created, updatedBlueprints: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}
