import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { resolveClientByClientId } from '../../lib/clients'
import {
  buildMapperRep,
  findMapperByName,
  mapperBasePath,
  resolveClientScopeByName,
  type KeycloakProtocolMapperRep,
  type ProtocolMapperTargetType,
} from './_shared'

/**
 * Deploy Keycloak protocol mappers over the Admin REST API. A mapper attaches
 * to an EXISTING client or an EXISTING client scope (targetType); both are
 * structurally identical sub-resources:
 *   resolve target:   GET  /clients?clientId=<targetRef>  or  GET /client-scopes
 *   read (identity):  GET  {base}/protocol-mappers/models          → match by name
 *   create:           POST {base}/protocol-mappers/models          with the representation
 *   update:           PUT  {base}/protocol-mappers/models/{id}     with a merged representation
 *
 * (targetType, targetRef, name) is the stable composite identity. rollbackData
 * records, per mapper, the RESOLVED parent id (not targetRef) so rollback is
 * unaffected by the target being renamed after this deploy ran.
 */

interface PreviousEntry {
  targetType: ProtocolMapperTargetType
  targetRef: string
  resolvedParentId: string
  name: string
  id: string | null
  mapper: KeycloakProtocolMapperRep | null
}

/** Resolve the target client/client-scope to its internal UUID, or throw a clear error. */
async function resolveParentId(
  admin: ReturnType<typeof buildAdminClient>,
  targetType: ProtocolMapperTargetType,
  targetRef: string,
): Promise<string> {
  if (targetType === 'client') {
    const client = await resolveClientByClientId(admin, targetRef)
    if (!client?.id) throw new Error(`client "${targetRef}" not found`)
    return client.id
  }
  const scope = await resolveClientScopeByName(admin, targetRef)
  if (!scope?.id) throw new Error(`"${targetRef}" (client-scope) not found`)
  return scope.id
}

/** Fetch the live mapper list under a resolved base and match by name (or null). */
async function fetchByName(
  admin: ReturnType<typeof buildAdminClient>,
  base: string,
  name: string,
): Promise<KeycloakProtocolMapperRep | null> {
  const res = await admin.get(base)
  if (!res.ok) return null
  const list = parseJson<KeycloakProtocolMapperRep[]>(res.body) ?? []
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
      const targetType = readString(item.fields.targetType) as ProtocolMapperTargetType
      const targetRef = readString(item.fields.targetRef)
      const name = readString(item.fields.name)
      if (!targetType || !targetRef || !name) continue

      const parentId = await resolveParentId(admin, targetType, targetRef)
      const base = mapperBasePath(targetType, parentId)

      const existing = await fetchByName(admin, base, name)

      if (existing?.id) {
        const rep = buildMapperRep(item.fields, existing)
        const res = await admin.put(`${base}/${encodeURIComponent(existing.id)}`, rep)
        if (!res.ok) throw new Error(`update ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ targetType, targetRef, resolvedParentId: parentId, name, id: existing.id, mapper: existing })
      } else {
        const rep = buildMapperRep(item.fields)
        const res = await admin.post(base, rep)
        if (!res.ok) throw new Error(`create ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        // Keycloak's 201 returns the new id only in the Location header; re-read
        // by name to capture it for rollback (delete-what-we-created).
        const created = await fetchByName(admin, base, name)
        previous.push({ targetType, targetRef, resolvedParentId: parentId, name, id: created?.id ?? null, mapper: null })
      }
      applied.push(`${targetType}:${targetRef}/${name}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} protocol mapper(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Protocol mapper deploy failed after ${applied.length} mapper(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
