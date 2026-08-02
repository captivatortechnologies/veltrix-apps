import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type AuthorizationProfile,
} from '../../lib/iseApi'
import { AUTHZ_PROFILE_TYPE } from './_shared'
import type { RollbackEntry } from './deploy'

/**
 * Undo an authorization-profiles deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT the prior fields back (restore), or — when
 * the profile was newly created (prior detail null) — DELETE it. Applied over
 * the ISE ERS API.
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
  const client = buildErsResourceClient<AuthorizationProfile>(base, 'authorizationprofile', 'AuthorizationProfile', credential, settings)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) {
        skipped++
        continue
      }
      if (entry.profile) {
        const p = entry.profile
        await client.update(entry.id, {
          name: p.name ?? entry.name,
          description: p.description ?? '',
          accessType: p.accessType,
          authzProfileType: AUTHZ_PROFILE_TYPE,
          acl: p.acl,
          daclName: p.daclName,
          airespaceACL: p.airespaceACL,
          vlan: p.vlan,
          advancedAttributes: p.advancedAttributes,
        })
        restored++
      } else {
        await client.remove(entry.id)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back authorization profiles: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
