import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildFilesetTemplateBody, type RubrikFilesetTemplate } from './_shared'

interface RollbackEntry {
  name: string
  existed: boolean
  id: string | null
  prior: RubrikFilesetTemplate | null
}

/**
 * Undo a fileset-templates deploy from rollbackData.previous (written by deploy()):
 *   - a template we CREATED (existed=false): DELETE /api/v1/fileset_template/{id}
 *   - a template we UPDATED (existed=true):  PATCH  /api/v1/fileset_template/{id} with the prior body
 * A created template we delete carries no snapshots yet, so preserve_snapshots=false
 * fully removes it. An entry whose id we never learned is skipped (nothing safe to
 * undo). Applied over the Rubrik CDM v1 REST API. FLAG: verify against a live cluster.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) {
        skipped++
        continue
      }
      const base = `/api/v1/fileset_template/${encodeURIComponent(entry.id)}`
      if (entry.existed && entry.prior) {
        await sendJson(conn, 'PATCH', base, buildFilesetTemplateBody(toFields(entry.prior)))
        restored++
      } else {
        await sendJson(conn, 'DELETE', `${base}?preserve_snapshots=false`)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back fileset templates: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

/** Re-derive the canvas-shaped fields from a prior live template so buildFilesetTemplateBody re-emits it. */
function toFields(prior: RubrikFilesetTemplate): Record<string, unknown> {
  return {
    name: prior.name,
    operatingSystemType: prior.operatingSystemType,
    includes: prior.includes ?? [],
    excludes: prior.excludes ?? [],
    exceptions: prior.exceptions ?? [],
    useWindowsVss: prior.useWindowsVss === true,
    allowBackupNetworkMounts: prior.allowBackupNetworkMounts === true,
    allowBackupHiddenFoldersInNetworkMounts: prior.allowBackupHiddenFoldersInNetworkMounts === true,
    preBackupScript: prior.preBackupScript ?? '',
    postBackupScript: prior.postBackupScript ?? '',
    backupScriptTimeout: prior.backupScriptTimeout ?? 0,
    backupScriptErrorHandling: prior.backupScriptErrorHandling ?? '',
  }
}
