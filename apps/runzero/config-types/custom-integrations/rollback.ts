import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, runzeroRequest, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import { buildCustomIntegrationBodyFromPrior, type CustomIntegrationRollbackEntry } from './_shared'

/**
 * Undo a custom-integrations deploy from rollbackData.previous (written by deploy):
 *   - an integration that was CREATED (existed:false) is deleted
 *     (DELETE /account/custom-integrations/{id})
 *   - an integration that was UPDATED (existed:true) is restored to its prior body
 *     (PATCH /account/custom-integrations/{id})
 * Entries are reverted in reverse order. Applied over the runZero console REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: CustomIntegrationRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  let restored = 0
  let deleted = 0
  let left = 0
  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.integrationId) {
        left++
        continue
      }
      if (!entry.existed) {
        const res = await runzeroRequest(`${base}/account/custom-integrations/${encodeURIComponent(entry.integrationId)}`, { method: 'DELETE', headers, timeoutMs })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete custom integration "${entry.name}": HTTP ${res.status}`)
        }
        deleted++
      } else if (entry.prior) {
        await sendJson(
          'PATCH',
          `${base}/account/custom-integrations/${encodeURIComponent(entry.integrationId)}`,
          headers,
          buildCustomIntegrationBodyFromPrior(entry.prior),
          timeoutMs,
        )
        restored++
      } else {
        left++
      }
    }
    return {
      success: true,
      message: `Rolled back custom integrations: ${restored} restored, ${deleted} deleted${left ? `, ${left} left in place` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
