import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, sendJson, groupResourcePath } from '../../lib/criblApi'
import { WORKER_GROUP_SETTINGS_RESOURCE } from './_shared'

/**
 * Undo a Worker Group Settings deploy from rollbackData.previous: PATCH each
 * group's FULL prior settings object back (captured by deploy() before it
 * patched). A group whose prior snapshot could not be read (best-effort GET
 * failure at deploy time) is skipped and called out in the result message.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ group: string; settings: Record<string, unknown> | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for Worker Group Settings rollback' }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  let restored = 0
  let skipped = 0
  try {
    const headers = await criblConnect(base, credential)

    for (const { group, settings: prior } of previous) {
      if (!prior) {
        skipped++
        continue
      }
      const url = groupResourcePath(base, group, WORKER_GROUP_SETTINGS_RESOURCE)
      await sendJson('PATCH', url, headers, prior)
      restored++
    }
    const skippedNote = skipped ? ` ${skipped} group(s) skipped — no prior snapshot was captured.` : ''
    return { success: true, message: `Rolled back Worker Group Settings: ${restored} restored.${skippedNote}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
