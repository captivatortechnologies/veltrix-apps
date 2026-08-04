import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { buildMapperRep, findMapperByName, type KeycloakIdpMapperRep } from './_shared'

/**
 * Deploy Keycloak identity-provider mappers over the Admin REST API. The mapper
 * attaches to an EXISTING identity provider instance (see the
 * identity-providers config type — this type does not create IdPs):
 *   precheck:          GET  /identity-provider/instances/{alias}                → the IdP must exist
 *   read (identity):   GET  /identity-provider/instances/{alias}/mappers        → match by name
 *   create:            POST /identity-provider/instances/{alias}/mappers        with the representation
 *   update:            PUT  /identity-provider/instances/{alias}/mappers/{id}   with a merged representation
 *
 * (alias, name) is the stable composite identity. rollbackData records, per
 * mapper, the prior representation (null when created) so rollback can restore
 * the prior body or delete what we created.
 */

interface PreviousEntry {
  alias: string
  name: string
  id: string | null
  mapper: KeycloakIdpMapperRep | null
}

/** Fetch the live mapper list for an alias and match by name (or null), best-effort. */
async function fetchByName(
  admin: ReturnType<typeof buildAdminClient>,
  alias: string,
  name: string,
): Promise<KeycloakIdpMapperRep | null> {
  const res = await admin.get(`/identity-provider/instances/${encodeURIComponent(alias)}/mappers`)
  if (!res.ok) return null
  const list = parseJson<KeycloakIdpMapperRep[]>(res.body) ?? []
  return findMapperByName(list, name)
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
      const name = readString(item.fields.name)
      if (!alias || !name) continue

      const idpRes = await admin.get(`/identity-provider/instances/${encodeURIComponent(alias)}`)
      if (!idpRes.ok) {
        throw new Error(
          `identity provider "${alias}" not found — create it first via the Identity Providers config type`,
        )
      }

      const base = `/identity-provider/instances/${encodeURIComponent(alias)}/mappers`
      const existing = await fetchByName(admin, alias, name)

      if (existing?.id) {
        const rep = buildMapperRep(item.fields, alias, existing)
        const res = await admin.put(`${base}/${encodeURIComponent(existing.id)}`, rep)
        if (!res.ok) throw new Error(`update ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ alias, name, id: existing.id, mapper: existing })
      } else {
        const rep = buildMapperRep(item.fields, alias)
        const res = await admin.post(base, rep)
        if (!res.ok) throw new Error(`create ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        // Keycloak's 201 returns the new id only in the Location header; re-read
        // by name to capture it for rollback (delete-what-we-created).
        const created = await fetchByName(admin, alias, name)
        previous.push({ alias, name, id: created?.id ?? null, mapper: null })
      }
      applied.push(`${alias}/${name}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} identity provider mapper(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity provider mapper deploy failed after ${applied.length} mapper(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
