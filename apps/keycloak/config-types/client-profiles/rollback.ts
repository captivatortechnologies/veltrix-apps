import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import type { ClientProfileRepresentation } from './_shared'
import type { ClientProfilesRollbackData } from './deploy'

/**
 * Roll back client profiles using the state captured during deploy: restore the exact
 * prior custom-profile list with ONE PUT of `{ profiles: rollbackData.priorProfiles }`
 * (never `globalProfiles` — see _shared.ts). A prior list of zero profiles is a valid
 * state to restore to, so an empty array is not treated as "nothing to roll back" —
 * only a genuinely missing `rollbackData` is.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = ctx.rollbackData as ClientProfilesRollbackData | undefined
  const priorProfiles: ClientProfileRepresentation[] | undefined = data?.priorProfiles
  if (!priorProfiles) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  try {
    const res = await admin.put('/client-policies/profiles', { profiles: priorProfiles })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return { success: true, message: `Rolled back client profiles to the prior list of ${priorProfiles.length} profile(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
