import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { buildAuthFlowRep, builtInRefusalMessage, findFlowByAlias, type KeycloakAuthFlowRep } from './_shared'

/**
 * Deploy Keycloak authentication flow CONTAINERS over the Admin REST API:
 *   read (identity):  GET  /authentication/flows            → list ALL flows; there
 *                     is no direct get-by-alias endpoint, so upsert matches by exact
 *                     `alias` client-side (same list+match shape as the groups
 *                     config type's findGroupByName)
 *   create:           POST /authentication/flows              always forces
 *                     topLevel:true, builtIn:false regardless of any input — a
 *                     custom top-level flow is the only safe thing authored here
 *   update:           PUT  /authentication/flows/{id}          {id} is the flow's
 *                     INTERNAL id, not its alias; only alias/description are
 *                     mutated — providerId is treated as immutable after creation
 *
 * SAFETY: this config type never modifies or deletes a live flow whose builtIn is
 * true (Keycloak's own browser/direct grant/registration/… flows). An item whose
 * alias matches a live built-in flow fails this deploy loudly instead of silently
 * rewriting it — see builtInRefusalMessage in _shared.ts.
 *
 * SCOPE: this manages only the flow container (alias, description, providerId) — it
 * does NOT author the execution/step graph inside a flow
 * (.../authentication/flows/{flowAlias}/executions), a materially riskier,
 * ordering-dependent surface. A flow created here is an empty container an operator
 * finishes wiring up in Keycloak's own flow designer.
 *
 * rollbackData records, per flow, the prior representation (null when we created
 * it) plus its internal id so rollback can restore the prior body or delete what
 * was created.
 */

interface PreviousEntry {
  alias: string
  id: string | null
  flow: KeycloakAuthFlowRep | null
}

/** List every flow in the managed realm. Best-effort ([] on a non-2xx response). */
async function listFlows(admin: ReturnType<typeof buildAdminClient>): Promise<KeycloakAuthFlowRep[]> {
  const res = await admin.get('/authentication/flows')
  if (!res.ok) return []
  return parseJson<KeycloakAuthFlowRep[]>(res.body) ?? []
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
      if (!alias) continue

      const existing = findFlowByAlias(await listFlows(admin), alias)

      if (existing?.builtIn === true) {
        throw new Error(builtInRefusalMessage(alias))
      }

      if (existing?.id) {
        const rep = buildAuthFlowRep(item.fields, existing)
        const res = await admin.put(`/authentication/flows/${encodeURIComponent(existing.id)}`, rep)
        if (!res.ok) throw new Error(`update ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ alias, id: existing.id, flow: existing })
      } else {
        const rep = buildAuthFlowRep(item.fields)
        const res = await admin.post('/authentication/flows', rep)
        if (!res.ok) throw new Error(`create ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        // POST does not return the new id in the body — re-list and match by alias.
        const created = findFlowByAlias(await listFlows(admin), alias)
        previous.push({ alias, id: created?.id ?? null, flow: null })
      }
      applied.push(alias)
    }

    return {
      success: true,
      message: `Applied ${applied.length} authentication flow(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authentication flow deploy failed after ${applied.length} flow(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
