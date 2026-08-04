import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import {
  buildComponentRep,
  findComponentByName,
  stripSecretsFromComponent,
  USER_STORAGE_PROVIDER_TYPE,
  type KeycloakComponentRep,
} from './_shared'

/**
 * Deploy Keycloak user-federation (LDAP/Kerberos) components over the Admin
 * REST API:
 *   realm id:  GET  /admin/realms/{realm}                → .id, used as parentId (NOT assumed to equal the realm name)
 *   list:      GET  /components?parentId={id}&type=org.keycloak.storage.UserStorageProvider
 *   create:    POST /components                            with a ComponentRepresentation
 *   update:    PUT  /components/{id}                        with a merged ComponentRepresentation
 *
 * The component `name` is the stable identity used to upsert. There is no
 * name filter on the list endpoint, so this fetches the full list and matches
 * client-side — the same shape as the groups config type's findGroupByName.
 *
 * rollbackData records, per item, the prior representation with
 * bindCredential/keyTab already stripped out of its config (see _shared.ts's
 * stripSecretsFromComponent doc comment for why) so rollback can restore the
 * prior body or delete what we created, without ever writing Keycloak's
 * masked "**********" placeholder back as if it were a real secret.
 */
interface PreviousEntry {
  name: string
  id: string | null
  component: KeycloakComponentRep | null
}

async function fetchRealmId(admin: ReturnType<typeof buildAdminClient>): Promise<string | null> {
  const res = await admin.get('')
  if (!res.ok) return null
  return parseJson<{ id?: string }>(res.body)?.id ?? null
}

async function listComponents(admin: ReturnType<typeof buildAdminClient>, realmId: string): Promise<KeycloakComponentRep[]> {
  const res = await admin.get(`/components?parentId=${encodeURIComponent(realmId)}&type=${encodeURIComponent(USER_STORAGE_PROVIDER_TYPE)}`)
  if (!res.ok) return []
  return parseJson<KeycloakComponentRep[]>(res.body) ?? []
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
    const realmId = await fetchRealmId(admin)
    if (!realmId) throw new Error('could not resolve the realm internal id (GET /admin/realms/{realm})')

    let existingList = await listComponents(admin, realmId)

    for (const item of items) {
      const name = readString(item.fields.name)
      if (!name) continue

      const existing = findComponentByName(existingList, name)

      if (existing?.id) {
        const rep = buildComponentRep(item.fields, existing)
        rep.parentId = realmId
        const res = await admin.put(`/components/${encodeURIComponent(existing.id)}`, rep)
        if (!res.ok) throw new Error(`update ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ name, id: existing.id, component: stripSecretsFromComponent(existing) })
      } else {
        const rep = buildComponentRep(item.fields)
        rep.parentId = realmId
        const res = await admin.post('/components', rep)
        if (!res.ok) throw new Error(`create ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        // Keycloak's 201 returns the new id only in the Location header; re-list
        // and match by name to capture it for rollback (same pattern as groups).
        existingList = await listComponents(admin, realmId)
        const created = findComponentByName(existingList, name)
        previous.push({ name, id: created?.id ?? null, component: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} user federation provider(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `User federation deploy failed after ${applied.length} provider(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
