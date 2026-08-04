import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, deletePath, sendJson, withSession } from '../../lib/beyondtrustApi'
import type { Directory } from './_shared'

/**
 * Undo a directories deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /Directories/{id} with the prior representation (restore
 * a directory this deploy UPDATED), or DELETE /Directories/{id} for one this
 * deploy CREATED (previous null). A delete or restore that fails — e.g. the
 * directory now has linked accounts — is skipped rather than failing the whole
 * rollback. Applied over the BeyondInsight REST API inside a PS-Auth session.
 *
 * NOTE: verify PUT/DELETE /Directories/{id} against a live BeyondTrust instance
 * — the exact DELETE path shape is unconfirmed from the public API reference.
 */
interface RollbackEntry {
  workgroupName: string
  domainName: string
  directoryId: number | string | null
  previous: Directory | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for directory rollback' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  let restored = 0
  let deleted = 0
  let skipped = 0

  try {
    await withSession(base, credential, async (cookie) => {
      for (const entry of previous) {
        if (entry.directoryId == null) {
          skipped++
          continue
        }
        const path = `/Directories/${encodeURIComponent(String(entry.directoryId))}`
        try {
          if (entry.previous) {
            await sendJson('PUT', base, path, cookie, entry.previous)
            restored++
          } else {
            await deletePath(base, path, cookie)
            deleted++
          }
        } catch {
          // Likely has linked accounts or requires admin to remove — leave it rather than fail.
          skipped++
        }
      }
    })
    return {
      success: true,
      message: `Rolled back directories: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
