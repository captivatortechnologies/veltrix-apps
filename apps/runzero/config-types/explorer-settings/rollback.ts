import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import type { ExplorerSettingsRollbackEntry, RunzeroAgentPatchedSettings } from './_shared'

/**
 * Undo an explorer-settings deploy from rollbackData.previous (written by deploy): restores each
 * explorer's `site_id` to what it was before deploy (PATCH /org/explorers/{id}). There is nothing
 * to delete — this config type never creates an Explorer. `max_concurrent_scans` is NEVER restored
 * — the restore body omits the `settings` key entirely rather than guessing (see the WRITE-ONLY
 * note in _shared.ts); the concurrency value deploy applied is left in place. Entries are reverted
 * in reverse order.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: ExplorerSettingsRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  let restored = 0
  let left = 0
  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.explorerId || !entry.priorSiteId) {
        left++
        continue
      }
      const body: RunzeroAgentPatchedSettings = { site_id: entry.priorSiteId }
      await sendJson('PATCH', `${base}/org/explorers/${encodeURIComponent(entry.explorerId)}`, headers, body, timeoutMs)
      restored++
    }
    return {
      success: true,
      message: `Rolled back explorer settings: ${restored} restored${left ? `, ${left} left in place (no prior site on record)` : ''}. Max Concurrent Scans is never restored (write-only) — see the app README.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
