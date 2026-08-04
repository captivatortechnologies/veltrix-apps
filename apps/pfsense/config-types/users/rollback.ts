import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings } from '../../lib/pfsenseApi'
import type { RollbackEntry } from './deploy'

/**
 * Undo a users deploy from rollbackData.previous. No apply step — writes
 * apply immediately (see deploy.ts's module doc). `password` is never
 * restored (write-only in spirit — see _shared.ts's module doc); a rolled-
 * back user that was UPDATED keeps whatever password it currently has.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const auth = await client.authenticate()
  if (auth.error) return { success: false, message: auth.error }

  let restored = 0
  let deleted = 0
  let skipped = 0

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.id) {
        skipped++
        continue
      }
      if (entry.prior) {
        await client.updateUser(entry.id, entry.prior)
        restored++
      } else {
        await client.deleteUser(entry.id)
        deleted++
      }
    }

    return {
      success: true,
      message: `Rolled back pfSense users: ${restored} restored (passwords untouched), ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
