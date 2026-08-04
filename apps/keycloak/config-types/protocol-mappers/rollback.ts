import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import { mapperBasePath, type KeycloakProtocolMapperRep, type ProtocolMapperTargetType } from './_shared'

/**
 * Undo a protocol-mappers deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT {base}/{id} with the prior representation
 * (restore), or — when the mapper was newly created (prior body null) — DELETE
 * {base}/{id} to remove it. Uses the STORED resolvedParentId directly rather
 * than re-resolving targetRef, so rollback is unaffected by a rename of the
 * client/client scope after this deploy ran. Applied over the Keycloak Admin
 * REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{
      targetType: ProtocolMapperTargetType
      targetRef: string
      resolvedParentId: string
      name: string
      id: string | null
      mapper: KeycloakProtocolMapperRep | null
    }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { targetType, resolvedParentId, id, mapper } of previous) {
      if (id == null) {
        // A created mapper whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const base = mapperBasePath(targetType, resolvedParentId)
      if (mapper) {
        const res = await admin.put(`${base}/${encodeURIComponent(id)}`, mapper)
        if (!res.ok) throw new Error(`restore ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      } else {
        const res = await admin.delete(`${base}/${encodeURIComponent(id)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back protocol mappers: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
