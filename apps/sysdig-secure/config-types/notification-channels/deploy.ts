import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigClient, type SysdigNotificationChannel } from '../../lib/sysdigApi'
import { buildChannelBody, findChannelByName, normalizeBoolean } from './_shared'

/**
 * Deploy Sysdig Secure notification channels over the REST API:
 *   find:    GET    /api/notificationChannels           (list all, match by name)
 *   create:  POST   /api/notificationChannels
 *   update:  PUT    /api/notificationChannels/<id>       (carries the live id + version)
 *   remove:  DELETE /api/notificationChannels/<id>       (for a disabled channel)
 *
 * The channel name is the stable identity used to upsert. `enabled: false` is
 * modeled as "absent", mirroring every other config type in this app.
 * rollbackData records, per channel, the action taken and the prior body.
 */
type ChannelAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: ChannelAction
  channelId: number | null
  prior: SysdigNotificationChannel | null
}

async function findLive(client: SysdigClient, name: string): Promise<SysdigNotificationChannel | null> {
  try {
    return findChannelByName(await client.listNotificationChannels(), name)
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
          await client.deleteNotificationChannel(existingId)
          previous.push({ name, action: 'deleted', channelId: existingId, prior: existing })
        } else {
          previous.push({ name, action: 'noop', channelId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const body = buildChannelBody(item.fields)
      if (existing && existingId != null) {
        await client.updateNotificationChannel(existingId, { ...body, id: existingId, version: existing.version })
        previous.push({ name, action: 'updated', channelId: existingId, prior: existing })
      } else {
        const created = await client.createNotificationChannel(body)
        const newId = typeof created?.id === 'number' ? created.id : null
        previous.push({ name, action: 'created', channelId: newId, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} notification channel(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Notification channel deploy failed after ${applied.length} channel(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
