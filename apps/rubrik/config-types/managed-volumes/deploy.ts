import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import {
  buildManagedVolumeBody,
  buildManagedVolumePatchBody,
  findManagedVolumeByName,
  managedVolumesFromList,
  normalizeName,
  type RubrikManagedVolume,
} from './_shared'

/**
 * Deploy Rubrik managed volumes over the CDM internal REST API:
 *   read (rollback): GET   /api/internal/managed_volume     -> find the live MV by name
 *   create:          POST  /api/internal/managed_volume       with the full MV body
 *   update:          PATCH /api/internal/managed_volume/{id}  with the mutable subset (MV exists)
 *
 * The MV name is the stable identity used to upsert. numChannels and volumeSize are
 * fixed at creation, so an existing MV is PATCHed with only its mutable fields
 * (name, exportConfig). rollbackData records, per MV, whether it existed, its id,
 * and the prior object — so rollback can restore the prior export config or delete
 * the one we created.
 *
 * FLAG: verify the /api/internal/managed_volume create/patch body shape (and the
 * exportConfig structure) against a live Rubrik CDM cluster.
 */
interface RollbackEntry {
  name: string
  existed: boolean
  id: string | null
  prior: RubrikManagedVolume | null
}

/** Read every live managed volume (best-effort) for identity matching + snapshots. */
async function listManagedVolumes(conn: Awaited<ReturnType<typeof rubrikConnect>>): Promise<RubrikManagedVolume[]> {
  try {
    return managedVolumesFromList(await getJson<unknown>(conn, '/api/internal/managed_volume'))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    const live = await listManagedVolumes(conn)

    for (const item of items) {
      const name = normalizeName(item.fields.name)
      if (!name) continue

      const existing = findManagedVolumeByName(live, name)

      if (existing && existing.id) {
        await sendJson(conn, 'PATCH', `/api/internal/managed_volume/${encodeURIComponent(existing.id)}`, buildManagedVolumePatchBody(item.fields))
        previous.push({ name, existed: true, id: existing.id, prior: existing })
      } else {
        const created = await sendJson<RubrikManagedVolume>(conn, 'POST', '/api/internal/managed_volume', buildManagedVolumeBody(item.fields))
        previous.push({ name, existed: false, id: created?.id ?? null, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} managed volume(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { base: conn.base, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Managed volume deploy failed after ${applied.length} of ${items.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { base: conn.base, applied },
      rollbackData: { previous },
    }
  }
}
