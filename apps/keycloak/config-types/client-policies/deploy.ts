import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { buildPolicyRep, extractClientPolicySpecs, parseConditionsField, type ClientPoliciesRepresentation, type ClientPolicyRepresentation } from './_shared'

/** The complete prior custom-policy list, captured immediately before this deploy's PUT. */
export interface ClientPoliciesRollbackData {
  priorPolicies: ClientPolicyRepresentation[]
}

/**
 * Deploy Keycloak client policies over the Admin REST API. Like the sibling
 * client-profiles config type, `client-policies/policies` is a realm-wide WHOLE-LIST
 * singleton — one list to read, one list to write, covering every declared item
 * together:
 *
 *   read (rollback):  GET /client-policies/policies  -> { policies, globalPolicies? }
 *   apply:            PUT /client-policies/policies   with { policies: desired }
 *
 * `globalPolicies` is NEVER read from the GET response into the PUT body — Keycloak's
 * own built-in policies live there and are managed entirely server-side (see
 * _shared.ts). A `profiles` entry that does not resolve to a real profile (custom or
 * global) is rejected by Keycloak itself and surfaces here as a plain deploy error.
 * `rollbackData.priorPolicies` is the exact prior list; rollback.ts restores it
 * verbatim with a single PUT.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })
  const specs = extractClientPolicySpecs(canvas).filter((s) => s.name)

  try {
    const currentRes = await admin.get('/client-policies/policies')
    if (!currentRes.ok) {
      throw new Error(`read client-policies/policies → HTTP ${currentRes.status}: ${currentRes.body.slice(0, 300)}`)
    }
    const current = parseJson<ClientPoliciesRepresentation>(currentRes.body)
    const priorPolicies: ClientPolicyRepresentation[] = current?.policies ?? []

    const desiredPolicies: ClientPolicyRepresentation[] = []
    for (const spec of specs) {
      const { conditions, error } = parseConditionsField(spec.conditionsRaw)
      if (error || !conditions) throw new Error(`Client policy "${spec.name}": ${error ?? 'invalid conditions'}`)
      desiredPolicies.push(buildPolicyRep(spec.name, spec.description, spec.enabled, conditions, spec.profiles))
    }

    const putRes = await admin.put('/client-policies/policies', { policies: desiredPolicies })
    if (!putRes.ok) {
      throw new Error(`write client-policies/policies → HTTP ${putRes.status}: ${putRes.body.slice(0, 300)}`)
    }

    return {
      success: true,
      message: `Applied ${desiredPolicies.length} client polic${desiredPolicies.length === 1 ? 'y' : 'ies'}: ${desiredPolicies.map((p) => p.name).join(', ') || '(none)'}`,
      artifacts: { applied: desiredPolicies.map((p) => p.name) },
      rollbackData: { priorPolicies } as ClientPoliciesRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Client policies deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
