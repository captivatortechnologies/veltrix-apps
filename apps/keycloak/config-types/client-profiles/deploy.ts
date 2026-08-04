import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { buildProfileRep, extractClientProfileSpecs, parseExecutorsField, type ClientProfileRepresentation, type ClientProfilesRepresentation } from './_shared'

/** The complete prior custom-profile list, captured immediately before this deploy's PUT. */
export interface ClientProfilesRollbackData {
  priorProfiles: ClientProfileRepresentation[]
}

/**
 * Deploy Keycloak client profiles over the Admin REST API. Unlike every other config
 * type in this app, `client-policies/profiles` is a realm-wide WHOLE-LIST singleton —
 * there is one list to read and one list to write, covering every declared item
 * together:
 *
 *   read (rollback):  GET /client-policies/profiles  -> { profiles, globalProfiles? }
 *   apply:            PUT /client-policies/profiles   with { profiles: desired }
 *
 * `globalProfiles` is NEVER read from the GET response into the PUT body — Keycloak's
 * own built-in profiles live there and are managed entirely server-side (see
 * _shared.ts). `rollbackData.priorProfiles` is the exact prior list; rollback.ts
 * restores it verbatim with a single PUT.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })
  const specs = extractClientProfileSpecs(canvas).filter((s) => s.name)

  try {
    const currentRes = await admin.get('/client-policies/profiles')
    if (!currentRes.ok) {
      throw new Error(`read client-policies/profiles → HTTP ${currentRes.status}: ${currentRes.body.slice(0, 300)}`)
    }
    const current = parseJson<ClientProfilesRepresentation>(currentRes.body)
    const priorProfiles: ClientProfileRepresentation[] = current?.profiles ?? []

    const desiredProfiles: ClientProfileRepresentation[] = []
    for (const spec of specs) {
      const { executors, error } = parseExecutorsField(spec.executorsRaw)
      if (error || !executors) throw new Error(`Client profile "${spec.name}": ${error ?? 'invalid executors'}`)
      desiredProfiles.push(buildProfileRep(spec.name, spec.description, executors))
    }

    const putRes = await admin.put('/client-policies/profiles', { profiles: desiredProfiles })
    if (!putRes.ok) {
      throw new Error(`write client-policies/profiles → HTTP ${putRes.status}: ${putRes.body.slice(0, 300)}`)
    }

    return {
      success: true,
      message: `Applied ${desiredProfiles.length} client profile(s): ${desiredProfiles.map((p) => p.name).join(', ') || '(none)'}`,
      artifacts: { applied: desiredProfiles.map((p) => p.name) },
      rollbackData: { priorProfiles } as ClientProfilesRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Client profiles deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
