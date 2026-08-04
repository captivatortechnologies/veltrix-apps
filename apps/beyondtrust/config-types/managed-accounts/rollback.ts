import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, deletePath, sendJson, withSession } from '../../lib/beyondtrustApi'
import type { ManagedAccount } from './_shared'

/**
 * Undo a managed-accounts deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /ManagedAccounts/{id} with the prior
 * representation (restore an account this deploy UPDATED), or DELETE
 * /ManagedAccounts/{id} for one this deploy CREATED (previous null). A delete
 * or restore that fails — e.g. the account is now referenced by an open
 * request — is skipped rather than failing the whole rollback. Applied over
 * the BeyondInsight REST API inside a PS-Auth session.
 *
 * NOTE: verify PUT/DELETE /ManagedAccounts/{id} against a live BeyondTrust
 * instance.
 */
interface RollbackEntry {
  systemName: string
  accountName: string
  domainName: string
  managedAccountId: number | string | null
  previous: ManagedAccount | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for managed account rollback' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  let restored = 0
  let deleted = 0
  let skipped = 0

  try {
    await withSession(base, credential, async (cookie) => {
      for (const entry of previous) {
        if (entry.managedAccountId == null) {
          skipped++
          continue
        }
        const path = `/ManagedAccounts/${encodeURIComponent(String(entry.managedAccountId))}`
        try {
          if (entry.previous) {
            await sendJson('PUT', base, path, cookie, entry.previous)
            restored++
          } else {
            await deletePath(base, path, cookie)
            deleted++
          }
        } catch {
          // Likely referenced by an open request or credential mismatch — leave it rather than fail.
          skipped++
        }
      }
    })
    return {
      success: true,
      message: `Rolled back managed accounts: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
