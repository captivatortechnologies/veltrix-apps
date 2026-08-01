import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient, visionOneWriteError, type VisionOneClient } from '../../lib/visionOneApi'
import {
  SUSPICIOUS_OBJECT_ENDPOINTS,
  buildObjectBody,
  findObject,
  objectsFromResponse,
  type SuspiciousObject,
} from './_shared'

/**
 * Deploy Trend Vision One user-defined suspicious objects over the public REST API:
 *   read (rollback): GET  /threatintel/suspiciousObjects  → best-effort prior snapshot
 *   upsert:          POST /threatintel/suspiciousObjects   with [ <object>, … ]
 *
 * The add endpoint upserts by the object VALUE — adding an existing object updates
 * its scan action / risk level / expiration — so a single bulk call reconciles
 * every item. rollbackData records, per object, the prior body (null when it did
 * not exist) so rollback can restore the prior settings or remove the one we added.
 *
 * VERIFY the add request body (array form) and the object field names against a
 * live Vision One tenant.
 */

/** Best-effort read of the live suspicious object list for identity matching + snapshots. */
async function listObjects(client: VisionOneClient): Promise<SuspiciousObject[]> {
  try {
    const res = await client.get(SUSPICIOUS_OBJECT_ENDPOINTS.list)
    if (!res.ok) return []
    return objectsFromResponse(res.json)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for suspicious-object deployment' }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ type: string; value: string; prior: SuspiciousObject | null }> = []
  const objects: SuspiciousObject[] = []
  const applied: string[] = []

  try {
    const live = await listObjects(client)

    for (const item of items) {
      const type = String(item.fields.type ?? '').trim()
      const value = String(item.fields.value ?? '').trim()
      const body = buildObjectBody(item.fields)
      if (!body) continue
      objects.push(body)
      previous.push({ type, value, prior: findObject(live, value) })
      applied.push(value)
    }

    if (objects.length === 0) {
      return { success: true, message: 'No suspicious objects to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    // Bulk upsert — the add endpoint takes the object array directly. VERIFY.
    const res = await client.post(SUSPICIOUS_OBJECT_ENDPOINTS.add, objects)
    const error = visionOneWriteError(res)
    if (error) {
      return {
        success: false,
        message: `Suspicious-object deploy failed: ${error}`,
        artifacts: { applied: [] },
        rollbackData: { previous },
      }
    }

    return {
      success: true,
      message: `Applied ${applied.length} suspicious object(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Suspicious-object deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied: [] },
      rollbackData: { previous },
    }
  }
}
