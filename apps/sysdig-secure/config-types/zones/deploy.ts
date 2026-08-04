import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigClient, type SysdigZone } from '../../lib/sysdigApi'
import { buildZoneBody, findZoneByName, normalizeBoolean } from './_shared'

/**
 * Deploy Sysdig Secure zones over the REST API:
 *   find:    GET    /platform/v1/zones?filter=name:<name>
 *   create:  POST   /platform/v1/zones
 *   update:  PUT    /platform/v1/zones/<id>
 *   remove:  DELETE /platform/v1/zones/<id>    (for a disabled zone)
 *
 * The zone name is the stable identity used to upsert. `enabled: false` is
 * modeled as "absent", mirroring every other config type in this app.
 * rollbackData records, per zone, the action taken and the prior body.
 */
type ZoneAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: ZoneAction
  zoneId: number | null
  prior: SysdigZone | null
}

async function findLive(client: SysdigClient, name: string): Promise<SysdigZone | null> {
  try {
    return findZoneByName(await client.findZonesByName(name), name)
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
      const enabled = normalizeBoolean(item.fields.enabled, true)

      const existing = await findLive(client, name)
      const existingId = typeof existing?.id === 'number' ? existing.id : null

      if (!enabled) {
        if (existing && existingId != null) {
          await client.deleteZone(existingId)
          previous.push({ name, action: 'deleted', zoneId: existingId, prior: existing })
        } else {
          previous.push({ name, action: 'noop', zoneId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const body = buildZoneBody(item.fields)
      if (existing && existingId != null) {
        await client.updateZone(existingId, { ...body, id: existingId })
        previous.push({ name, action: 'updated', zoneId: existingId, prior: existing })
      } else {
        const created = await client.createZone(body)
        const newId = typeof created?.id === 'number' ? created.id : null
        previous.push({ name, action: 'created', zoneId: newId, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} zone(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Zone deploy failed after ${applied.length} zone(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
