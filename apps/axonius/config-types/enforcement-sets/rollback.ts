import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, sendJson, verifyTls } from '../../lib/axoniusApi'
import { updateEnforcementResource, DELETE_ENFORCEMENT_RESOURCE, buildRestoreBody, buildDeleteBody } from './_shared'

/**
 * Undo an enforcement-sets deploy from rollbackData.previous (written by deploy()):
 *   updated set (prior attributes present): PUT api/enforcements/<uuid> with the prior
 *     full definition — restore.
 *   created set (prior attributes null):    DELETE api/enforcements with { value: { ids:[uuid],
 *     include:true } } — remove the one we created.
 * A set whose uuid we never learned is skipped. Applied over the Axonius REST API
 * (443). Verify the endpoints against a live Axonius tenant.
 */
interface PriorEntry {
  name: string
  uuid: string | null
  attributes: Record<string, unknown> | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for enforcement-set rollback' }
  }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) to roll back.' }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const opts = { verifyTls: verifyTls(settings) }

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { uuid, attributes } of previous) {
      if (!uuid) {
        skipped++
        continue
      }
      if (attributes) {
        await sendJson('PUT', apiUrl(base, settings, updateEnforcementResource(uuid)), headers, buildRestoreBody(uuid, attributes), opts)
        restored++
      } else {
        await sendJson('DELETE', apiUrl(base, settings, DELETE_ENFORCEMENT_RESOURCE), headers, buildDeleteBody(uuid), opts)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back enforcement sets: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
