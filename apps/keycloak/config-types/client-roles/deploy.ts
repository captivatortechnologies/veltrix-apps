import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import type { KeycloakAdminClient } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { resolveClientByClientId } from '../../lib/clients'
import { buildClientRoleRep, type KeycloakClientRoleRep } from './_shared'

/**
 * Deploy Keycloak client roles over the Admin REST API:
 *   resolve client:   GET    /clients?clientId=<clientId>  → the client's internal UUID
 *   read (identity):  GET    /clients/{clientUuid}/roles/{role-name}  → 200 live, 404 absent
 *   create:           POST   /clients/{clientUuid}/roles               with a RoleRepresentation
 *   update:           PUT    /clients/{clientUuid}/roles/{role-name}   with a merged RoleRepresentation
 *
 * The (clientId, name) pair is the stable identity used to upsert; the role name
 * is the {role-name} path segment once scoped under the resolved client. A
 * declared clientId that does not resolve to a live client fails that item
 * clearly rather than silently skipping it. rollbackData records, per role, the
 * RESOLVED clientUuid (not the human clientId) so rollback targets it directly —
 * robust against the client being renamed between deploy and rollback — plus the
 * prior representation (null when it did not exist).
 */

/** One rollback entry: the resolved client UUID + role name + prior representation (null if created). */
interface PreviousEntry {
  clientId: string
  clientUuid: string
  name: string
  role: KeycloakClientRoleRep | null
}

/** Fetch the live client role for a name under a resolved client (or null), best-effort. */
async function fetchByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
): Promise<KeycloakClientRoleRep | null> {
  const res = await admin.get(`/clients/${encodeURIComponent(clientUuid)}/roles/${encodeURIComponent(name)}`)
  if (!res.ok) return null
  return parseJson<KeycloakClientRoleRep>(res.body)
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
      const clientId = readString(item.fields.clientId)
      const name = readString(item.fields.name)
      if (!clientId || !name) continue

      const client = await resolveClientByClientId(admin, clientId)
      if (!client || !client.id) {
        throw new Error(`client "${clientId}" not found — create it first via the Clients config type`)
      }
      const clientUuid = client.id

      const existing = await fetchByName(admin, clientUuid, name)

      if (existing) {
        const rep = buildClientRoleRep(item.fields, existing)
        const res = await admin.put(`/clients/${encodeURIComponent(clientUuid)}/roles/${encodeURIComponent(name)}`, rep)
        if (!res.ok) throw new Error(`update ${clientId}/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ clientId, clientUuid, name, role: existing })
      } else {
        const rep = buildClientRoleRep(item.fields)
        const res = await admin.post(`/clients/${encodeURIComponent(clientUuid)}/roles`, rep)
        if (!res.ok) throw new Error(`create ${clientId}/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ clientId, clientUuid, name, role: null })
      }
      applied.push(`${clientId}/${name}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} client role(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Client role deploy failed after ${applied.length} role(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
