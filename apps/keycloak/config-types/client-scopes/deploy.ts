import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import {
  buildClientScopeRep,
  findClientScopeByName,
  reconcileRealmDefaultState,
  resolveRealmDefaultState,
  type KeycloakClientScopeRep,
  type RealmDefaultState,
} from './_shared'

/**
 * Deploy Keycloak client scopes over the Admin REST API:
 *   read (identity):  GET    /client-scopes         → list all, match by name
 *                                                      (no server-side ?search=)
 *   create:           POST   /client-scopes          with a ClientScopeRepresentation
 *   update:           PUT    /client-scopes/{id}     with a merged ClientScopeRepresentation
 *   realm assignment: reconciled via /default-default-client-scopes[/{id}] and
 *                      /default-optional-client-scopes[/{id}] AFTER the scope body
 *                      is written (the scope must exist first)
 *
 * The scope name is the stable identity used to upsert. rollbackData records, per
 * scope, the prior representation (null when it did not exist), the internal id,
 * and the prior realm-assignment state — so rollback can restore the prior body +
 * assignment or delete what we created.
 */

/** One rollback entry: prior representation (or null if created) + id + prior realm assignment. */
interface PreviousEntry {
  name: string
  id: string | null
  scope: KeycloakClientScopeRep | null
  priorRealmDefault: RealmDefaultState
}

/** Fetch the live client scope for a name (or null), best-effort. There is no
 * server-side name filter on this endpoint, so the full list is fetched. */
async function fetchByName(
  admin: ReturnType<typeof buildAdminClient>,
  name: string,
): Promise<KeycloakClientScopeRep | null> {
  const res = await admin.get('/client-scopes')
  if (!res.ok) return null
  const list = parseJson<KeycloakClientScopeRep[]>(res.body) ?? []
  return findClientScopeByName(list, name)
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

      let scopeId: string | null
      if (existing && existing.id) {
        const rep = buildClientScopeRep(item.fields, existing)
        const res = await admin.put(`/client-scopes/${encodeURIComponent(existing.id)}`, rep)
        if (!res.ok) throw new Error(`update ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        scopeId = existing.id
      } else {
        const rep = buildClientScopeRep(item.fields)
        const res = await admin.post('/client-scopes', rep)
        if (!res.ok) throw new Error(`create ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        // Keycloak's 201 returns the new id only in the Location header; re-read
        // by name to capture it for realm-assignment reconciliation and rollback.
        const created = await fetchByName(admin, name)
        scopeId = created?.id ?? null
      }

      const desiredRealmDefault = (readString(item.fields.realmDefault) || 'none') as RealmDefaultState
      let priorRealmDefault: RealmDefaultState = 'none'
      if (scopeId) {
        priorRealmDefault = await resolveRealmDefaultState(admin, scopeId)
        await reconcileRealmDefaultState(admin, scopeId, desiredRealmDefault, priorRealmDefault)
      }

      previous.push({ name, id: scopeId, scope: existing ?? null, priorRealmDefault })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} client scope(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Client scope deploy failed after ${applied.length} scope(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
