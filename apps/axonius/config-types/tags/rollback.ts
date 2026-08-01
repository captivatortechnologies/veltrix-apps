import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, sendJson, verifyTls } from '../../lib/axoniusApi'
import { labelsResource, buildTagBody, type TagEntity } from './_shared'

/**
 * Undo a tags deploy from rollbackData.previous (written by deploy()): remove each
 * label from exactly the assets it was applied to, using the same module + filter.
 *   DELETE api/<module>/labels with { entities, labels, filter }
 * Removing by the same filter reverts our change precisely — assets that carried
 * the tag for other reasons (outside the filter) are untouched. Applied over the
 * Axonius REST API (443). Verify the endpoint against a live Axonius tenant.
 */
interface PriorEntry {
  entity: TagEntity
  label: string
  filter: string
  existedBefore: boolean
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for tag rollback' }
  }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) to roll back.' }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const opts = { verifyTls: verifyTls(settings) }

  let removed = 0
  try {
    for (const { entity, label, filter } of previous) {
      await sendJson('DELETE', apiUrl(base, settings, labelsResource(entity)), headers, buildTagBody({ label, filter }), opts)
      removed++
    }
    return { success: true, message: `Rolled back tags: removed ${removed} tag${removed === 1 ? '' : 's'} from matching assets.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
