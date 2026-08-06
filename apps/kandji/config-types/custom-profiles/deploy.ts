import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient, type KandjiClient } from '../../lib/kandjiApi'
import {
  buildCustomProfileForm,
  customProfileKey,
  extractCustomProfileSpecs,
  indexCustomProfilesByName,
  type LiveCustomProfile,
} from './validate'

const CUSTOM_PROFILES_PATH = '/api/v1/library/custom-profiles'

export interface CustomProfileRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveCustomProfile
}

/** List every Custom Profile Library item, following pagination to completion. */
export async function listCustomProfiles(client: KandjiClient): Promise<LiveCustomProfile[]> {
  const res = await client.listAll<LiveCustomProfile>(CUSTOM_PROFILES_PATH)
  if (res.error) throw new Error(`Failed to list Kandji Custom Profiles: ${res.error}`)
  return res.nodes
}

/**
 * Deploy Kandji Custom Profiles via the tenant API: list, match by name,
 * create missing / update existing (capturing prior state for rollback).
 * Both create and update are multipart requests — see validate.ts.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractCustomProfileSpecs(ctx.canvas).filter((s) => s.name && s.profile)
  const rollbackState: CustomProfileRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listCustomProfiles(client)
    const byName = indexCustomProfilesByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = customProfileKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.requestMultipart(
          'PATCH',
          `${CUSTOM_PROFILES_PATH}/${encodeURIComponent(live.id)}`,
          buildCustomProfileForm(spec),
        )
        if (res.error) throw new Error(`Failed to update Custom Profile "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.requestMultipart<LiveCustomProfile>(
          'POST',
          CUSTOM_PROFILES_PATH,
          buildCustomProfileForm(spec),
        )
        if (res.error) throw new Error(`Failed to create Custom Profile "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Custom Profile "${label}" was created but Kandji returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} Kandji Custom Profile(s) on ${baseUrl}: ${created.length} created, ${updated.length} updated.`,
      artifacts: { baseUrl, createdCustomProfiles: created, updatedCustomProfiles: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom Profile deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, createdCustomProfiles: created, updatedCustomProfiles: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}
