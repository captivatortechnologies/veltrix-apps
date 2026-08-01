import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { buildIdpRep, type KeycloakIdpRep } from './_shared'

/**
 * Deploy Keycloak identity provider instances over the Admin REST API:
 *   read (identity):  GET  /identity-provider/instances/{alias}  → 200 live, 404 absent
 *   create:           POST /identity-provider/instances           with the representation
 *   update:           PUT  /identity-provider/instances/{alias}   with a merged representation
 *
 * The alias is the stable identity used to upsert AND the {alias} path segment.
 * rollbackData records, per provider, the prior representation (null when created)
 * so rollback can restore the prior body or delete what we created.
 */

/** One rollback entry: the alias + the prior representation (null if created). */
interface PreviousEntry {
  alias: string
  idp: KeycloakIdpRep | null
}

/** Fetch the live provider for an alias (or null), best-effort. */
async function fetchByAlias(
  admin: ReturnType<typeof buildAdminClient>,
  alias: string,
): Promise<KeycloakIdpRep | null> {
  const res = await admin.get(`/identity-provider/instances/${encodeURIComponent(alias)}`)
  if (!res.ok) return null
  return parseJson<KeycloakIdpRep>(res.body)
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const alias = readString(item.fields.alias)
      if (!alias) continue

      const existing = await fetchByAlias(admin, alias)

      if (existing) {
        const rep = buildIdpRep(item.fields, existing)
        const res = await admin.put(`/identity-provider/instances/${encodeURIComponent(alias)}`, rep)
        if (!res.ok) throw new Error(`update ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ alias, idp: existing })
      } else {
        const rep = buildIdpRep(item.fields)
        const res = await admin.post('/identity-provider/instances', rep)
        if (!res.ok) throw new Error(`create ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ alias, idp: null })
      }
      applied.push(alias)
    }

    return {
      success: true,
      message: `Applied ${applied.length} identity provider(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity provider deploy failed after ${applied.length} provider(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
