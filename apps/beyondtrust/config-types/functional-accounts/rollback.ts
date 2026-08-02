import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, deletePath, withSession } from '../../lib/beyondtrustApi'

/**
 * Undo a functional-accounts deploy from rollbackData.previous (written by
 * deploy()): DELETE /FunctionalAccounts/<id> for every account WE created. Accounts
 * that already existed before the deploy (action 'existing') are left as-is. A
 * delete that fails — e.g. the account is now referenced by a managed system
 * (SystemReferenceCount > 0) — is skipped rather than failing the whole rollback.
 * Applied over the BeyondInsight REST API inside a PS-Auth session.
 *
 * NOTE: verify DELETE /FunctionalAccounts/<id> against a live BeyondTrust instance.
 */
interface RollbackEntry {
  accountName: string
  platformId: number
  domainName: string
  functionalAccountId: number | string | null
  action: 'created' | 'existing'
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for functional account rollback' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  let deleted = 0
  let skipped = 0

  try {
    await withSession(base, credential, async (cookie) => {
      for (const entry of previous) {
        if (entry.action !== 'created' || entry.functionalAccountId == null) {
          skipped++
          continue
        }
        try {
          await deletePath(base, `/FunctionalAccounts/${encodeURIComponent(String(entry.functionalAccountId))}`, cookie)
          deleted++
        } catch {
          // Likely now referenced by a managed system — leave it rather than fail.
          skipped++
        }
      }
    })
    return {
      success: true,
      message: `Rolled back functional accounts: ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
