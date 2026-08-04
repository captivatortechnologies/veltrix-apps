import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, type InternalUser } from '../../lib/iseApi'
import type { RollbackEntry } from './deploy'

/**
 * Undo an internal-users deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT the prior NON-SECRET fields back (restore),
 * or — when the user was newly created (prior detail null) — DELETE it.
 *
 * ⚠ A user whose password or enable-password was CHANGED by the deploy cannot
 * have that secret restored — ISE never returns it, so it was never captured
 * (see deploy.ts's stripSecrets). Restoring such a user leaves their CURRENT
 * password in place rather than risk clearing it; reset it manually in ISE if
 * the prior value must be recovered.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<InternalUser>(base, 'internaluser', 'InternalUser', credential, settings)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) {
        skipped++
        continue
      }
      if (entry.user) {
        const u = entry.user
        await client.update(entry.id, {
          name: u.name ?? entry.username,
          description: u.description ?? '',
          firstName: u.firstName ?? '',
          lastName: u.lastName ?? '',
          email: u.email ?? '',
          identityGroups: u.identityGroups,
        })
        restored++
      } else {
        await client.remove(entry.id)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back internal users: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}. Passwords (if changed) were NOT restored — see this handler's module doc.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
