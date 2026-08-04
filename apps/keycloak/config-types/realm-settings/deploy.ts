import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { buildRealmPutBody, fetchRealmRep, projectFromFields, projectFromRealmRep, putRealmRep } from './_shared'

/**
 * Deploy realm-wide token/login/password-policy settings over the Admin REST
 * API (SINGLETON — one item, no list/match; the realm object always exists so
 * there is no create/delete branch):
 *   GET /admin/realms/{realm}   → the full live realm representation, fresh
 *   PUT /admin/realms/{realm}   → the same rep with our declared fields overridden
 *
 * rollbackData captures ONLY the narrow prior RealmSettingsProjection — never
 * the full realm rep read above — because RealmRepresentation also carries
 * smtpServer.password and other sensitive fields this config type does not
 * author (see _shared.ts for the full rationale).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]

  if (!item) return { success: false, message: 'No realm-settings configuration provided.' }
  if (!resolveGrant(credential)) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  try {
    const liveRealm = await fetchRealmRep(admin)
    if (!liveRealm) throw new Error('could not read the live realm representation')

    const priorProjection = projectFromRealmRep(liveRealm)
    const desired = projectFromFields(item.fields)

    await putRealmRep(admin, buildRealmPutBody(liveRealm, desired))

    return {
      success: true,
      message: 'Applied realm settings (token lifespans, login flags, password policy).',
      artifacts: { desired },
      rollbackData: priorProjection,
    }
  } catch (error) {
    return {
      success: false,
      message: `Realm-settings deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
