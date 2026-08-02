import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type AuthorizationProfile,
} from '../../lib/iseApi'
import { extractSpecs, toAuthorizationProfileBody } from './_shared'

/**
 * Deploy authorization profiles over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/authorizationprofile?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/authorizationprofile/{id}
 *   create:                      POST /ers/config/authorizationprofile
 *   update:                      PUT  /ers/config/authorizationprofile/{id}
 *
 * The profile NAME is the stable identity used to upsert. rollbackData
 * records, per profile, its id AND the prior full resource (null when it did
 * not exist) — so rollback can restore the prior fields or delete the one we
 * created. Every profile is sent as authzProfileType "SWITCH" — see the
 * module doc for what standard/TrustSec/TACACS+ scoping means here.
 */
export interface RollbackEntry {
  name: string
  id: string | null
  profile: AuthorizationProfile | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<AuthorizationProfile>(base, 'authorizationprofile', 'AuthorizationProfile', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name) continue

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, toAuthorizationProfileBody(spec))
        previous.push({ name: spec.name, id: existing.id, profile: prior })
      } else {
        const newId = await client.create(toAuthorizationProfileBody(spec))
        previous.push({ name: spec.name, id: newId, profile: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} authorization profile(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authorization profile deploy failed after ${applied.length} profile(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
