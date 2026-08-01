import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage } from '../../lib/cybereasonApi'
import { GROUP_ENDPOINTS, UNASSIGNED_GROUP_ID, groupId, type CybereasonGroup } from './_shared'

/**
 * Undo a sensor-group deploy from rollbackData.previous (written by deploy):
 * groups that existed before are RESTORED (PUT their prior body); groups this
 * deploy CREATED are DELETED by GUID, reassigning their sensors to the Unassigned
 * group. Applied over the Cybereason REST API.
 */
interface PreviousGroup {
  name: string
  prior: CybereasonGroup | null
  createdId: string | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PreviousGroup[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for sensor-group rollback' }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  let restored = 0
  let removed = 0
  let skipped = 0
  try {
    const session = await createSession(base, credential, timeoutMs)

    for (const { prior, createdId } of previous) {
      if (prior) {
        const id = groupId(prior)
        if (!id) {
          skipped++
          continue
        }
        const res = await session.putJson(GROUP_ENDPOINTS.update(id), prior)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`groups PUT (restore) → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        restored++
      } else if (createdId) {
        const res = await session.del(GROUP_ENDPOINTS.remove(createdId, UNASSIGNED_GROUP_ID))
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`groups DELETE → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        removed++
      } else {
        skipped++
      }
    }

    return {
      success: true,
      message: `Rolled back sensor groups: ${restored} restored, ${removed} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
