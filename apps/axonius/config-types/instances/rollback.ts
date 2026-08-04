import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, sendJson, verifyTls } from '../../lib/axoniusApi'
import { UPDATE_INSTANCE_RESOURCE, buildRestoreBody } from './_shared'

/**
 * Undo an instances deploy from rollbackData.previous (written by deploy()):
 * PUT api/instances with the flat update_attrs body restoring the prior
 * node_name/hostname/use_as_environment_name for each instance. This config
 * type never creates or deletes a node, so rollback is always a restore, never
 * a delete. Applied over the Axonius REST API (443). Verify against a live
 * Axonius tenant.
 */
interface PriorEntry {
  nodeId: string
  attributes: Record<string, unknown>
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for instance rollback' }
  }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) to roll back.' }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const opts = { verifyTls: verifyTls(settings) }

  let restored = 0
  try {
    for (const { nodeId, attributes } of previous) {
      await sendJson('PUT', apiUrl(base, settings, UPDATE_INSTANCE_RESOURCE), headers, buildRestoreBody(nodeId, attributes), opts)
      restored++
    }
    return { success: true, message: `Rolled back ${restored} instance${restored === 1 ? '' : 's'}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
