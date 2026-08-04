import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import { buildRealmPutBody, fetchRealmRep, putRealmRep, type RealmSettingsProjection } from './_shared'

/**
 * Undo a realm-settings deploy: fetch the full live realm representation fresh,
 * spread it with the narrow prior projection captured in rollbackData (written
 * by deploy()) overridden on top, and PUT it back. No create/delete branch —
 * the realm object always exists.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const prior = ctx.rollbackData as RealmSettingsProjection | undefined

  if (!prior) return { success: false, message: 'No previous state available for rollback.' }
  if (!resolveGrant(credential)) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  try {
    const liveRealm = await fetchRealmRep(admin)
    if (!liveRealm) throw new Error('could not read the live realm representation')

    await putRealmRep(admin, buildRealmPutBody(liveRealm, prior))

    return { success: true, message: 'Restored prior realm settings (token lifespans, login flags, password policy).' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
