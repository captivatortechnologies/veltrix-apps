import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

/**
 * Roll back a SOAR connection profile.
 *
 * A connection profile is never pushed to Splunk SOAR (see deploy.ts), so
 * there is no external state to revert — rollback is a no-op that always
 * succeeds.
 */
export default async function rollback(_ctx: RollbackContext): Promise<RollbackResult> {
  return { success: true, message: 'No external state to roll back' }
}
