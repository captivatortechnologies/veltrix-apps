import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import type { RollbackEntry } from './deploy'

const BASE = '/identity/b2xUserFlows'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let deleted = 0
  let refsRevoked = 0

  // Flows have no update — only app-created flows can be undone (deleted).
  // A pre-existing flow survives rollback; only the identityProvider/attribute
  // assignments THIS deploy itself added (existed:false) are reverted.
  for (const e of entries) {
    if (!e.id) continue
    if (!e.existed) {
      // We created this flow — remove it (its identityProvider/attribute
      // assignments go with it).
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${graphErrorMessage(resp)}`)
      else deleted++
      continue
    }

    for (const idp of e.identityProviders ?? []) {
      if (idp.existed) continue
      const resp = await client.delete(`${BASE}/${e.id}/identityProviders/${idp.id}/$ref`)
      if (!resp.ok && resp.status !== 404) failures.push(`revoke identity provider ${idp.id} from ${e.name}: ${graphErrorMessage(resp)}`)
      else refsRevoked++
    }
    for (const attr of e.attributes ?? []) {
      if (attr.existed) continue
      // A real DELETE (not $ref) — userAttributeAssignments are full sub-resources.
      const resp = await client.delete(`${BASE}/${e.id}/userAttributeAssignments/${attr.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`revoke attribute ${attr.id} from ${e.name}: ${graphErrorMessage(resp)}`)
      else refsRevoked++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return {
    success: true,
    message: `Rolled back b2x user flows: ${deleted} deleted, ${refsRevoked} identity provider/attribute assignment(s) revoked`,
  }
}
