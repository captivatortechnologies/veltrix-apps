import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { buildRoleRep, type KeycloakRoleRep } from './_shared'

/**
 * Deploy Keycloak realm roles over the Admin REST API:
 *   read (identity):  GET    /roles/{role-name}   → 200 the live role, 404 = absent
 *   create:           POST   /roles               with a RoleRepresentation
 *   update:           PUT    /roles/{role-name}   with a merged RoleRepresentation
 *
 * The role name is the stable identity used to upsert AND the {role-name} path
 * segment. rollbackData records, per role, the prior representation (null when it
 * did not exist) so rollback can restore the prior body or delete what we created.
 */

/** One rollback entry: the role name + the prior representation (null if created). */
interface PreviousEntry {
  name: string
  role: KeycloakRoleRep | null
}

/** Fetch the live role for a name (or null), best-effort. */
async function fetchByName(
  client: ReturnType<typeof buildAdminClient>,
  name: string,
): Promise<KeycloakRoleRep | null> {
  const res = await client.get(`/roles/${encodeURIComponent(name)}`)
  if (!res.ok) return null
  return parseJson<KeycloakRoleRep>(res.body)
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
      const name = readString(item.fields.name)
      if (!name) continue

      const existing = await fetchByName(admin, name)

      if (existing) {
        const rep = buildRoleRep(item.fields, existing)
        const res = await admin.put(`/roles/${encodeURIComponent(name)}`, rep)
        if (!res.ok) throw new Error(`update ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ name, role: existing })
      } else {
        const rep = buildRoleRep(item.fields)
        const res = await admin.post('/roles', rep)
        if (!res.ok) throw new Error(`create ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ name, role: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} realm role(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Realm role deploy failed after ${applied.length} role(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
