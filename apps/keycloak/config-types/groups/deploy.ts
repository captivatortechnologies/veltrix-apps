import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString, readStringArray } from '../../lib/fields'
import { buildGroupRep, findGroupByName, reconcileRealmRoles, type KeycloakGroupRep } from './_shared'

/**
 * Deploy Keycloak top-level groups over the Admin REST API:
 *   read (identity):  GET  /groups?search=<name>  → find the live top-level group
 *   create:           POST /groups                 with a GroupRepresentation
 *   update:           PUT  /groups/{id}            with a merged GroupRepresentation
 *   realm roles:      reconciled via /groups/{id}/role-mappings/realm (authoritative)
 *
 * The group name is the stable identity used to upsert. rollbackData records, per
 * group, the prior representation (null when created), the internal id, and the
 * prior realm role names — so rollback can restore the prior body + role mappings
 * or delete the group we created.
 */

/** One rollback entry: prior representation (or null if created) + id + prior roles. */
interface PreviousEntry {
  name: string
  id: string | null
  group: KeycloakGroupRep | null
  priorRealmRoles: string[]
}

/** Fetch the live top-level group for a name (or null), best-effort. */
async function fetchByName(
  admin: ReturnType<typeof buildAdminClient>,
  name: string,
): Promise<KeycloakGroupRep | null> {
  const res = await admin.get(`/groups?search=${encodeURIComponent(name)}`)
  if (!res.ok) return null
  const list = parseJson<KeycloakGroupRep[]>(res.body) ?? []
  return findGroupByName(list, name)
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
      const desiredRoles = readStringArray(item.fields.realmRoles)

      const existing = await fetchByName(admin, name)

      let groupId: string | null
      if (existing && existing.id) {
        const rep = buildGroupRep(item.fields, existing)
        const res = await admin.put(`/groups/${encodeURIComponent(existing.id)}`, rep)
        if (!res.ok) throw new Error(`update ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        groupId = existing.id
      } else {
        const rep = buildGroupRep(item.fields)
        const res = await admin.post('/groups', rep)
        if (!res.ok) throw new Error(`create ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        // Keycloak's 201 returns the new id only in the Location header; re-read by
        // name to capture it for role reconciliation and rollback.
        const created = await fetchByName(admin, name)
        groupId = created?.id ?? null
      }

      let priorRealmRoles: string[] = []
      if (groupId) {
        const reconciled = await reconcileRealmRoles(admin, groupId, desiredRoles)
        priorRealmRoles = reconciled.priorNames
      }

      previous.push({ name, id: groupId, group: existing ?? null, priorRealmRoles })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
