import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import { builtInRefusalMessage, findFlowByAlias, type KeycloakAuthFlowRep } from './_shared'

/**
 * Undo an authentication-flows deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /authentication/flows/{id} with the prior
 * representation (restore), or — when the flow was newly created (prior body null)
 * — DELETE /authentication/flows/{id} to remove it. Applied over the Keycloak
 * Admin REST API.
 *
 * SAFETY: before restoring or deleting, re-check the LIVE flow is still not
 * builtIn — same precondition as deploy. This should never trip in practice (only
 * a non-builtIn match is ever recorded for restore, and create always forces
 * builtIn:false so a delete target was never builtIn either); the guard exists so
 * rollback fails loudly rather than silently rewriting/removing a built-in flow if
 * that invariant is ever violated upstream.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ alias: string; id: string | null; flow: KeycloakAuthFlowRep | null }>
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
    for (const { alias, id, flow } of previous) {
      if (id == null) {
        // A created flow whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }

      const listRes = await admin.get('/authentication/flows')
      const live = listRes.ok ? findFlowByAlias(parseJson<KeycloakAuthFlowRep[]>(listRes.body) ?? [], alias) : null
      if (live?.builtIn === true) {
        throw new Error(builtInRefusalMessage(alias))
      }

      if (flow) {
        const res = await admin.put(`/authentication/flows/${encodeURIComponent(id)}`, flow)
        if (!res.ok) throw new Error(`restore ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      } else {
        const res = await admin.delete(`/authentication/flows/${encodeURIComponent(id)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back authentication flows: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
