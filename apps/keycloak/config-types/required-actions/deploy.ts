import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { buildRequiredActionRep, type KeycloakRequiredActionRep } from './_shared'

/**
 * Deploy Keycloak required actions over the Admin REST API:
 *   read (identity):  GET  /authentication/required-actions/{alias}   → 200 live,
 *                     404 absent (a direct retrieve-by-identity endpoint, unlike
 *                     authentication-flows)
 *   register:         POST /authentication/register-required-action    body
 *                     {providerId, name} — registers a realm-scoped required
 *                     action for a provider Keycloak's server knows about but this
 *                     realm hasn't enabled yet; the resulting alias equals
 *                     providerId. A non-2xx here means the provider genuinely does
 *                     not exist on this server — surfaced as a clear error rather
 *                     than swallowed.
 *   update:           PUT  /authentication/required-actions/{alias}    with a
 *                     merged RequiredActionProviderRepresentation (alias/providerId
 *                     are immutable and never written)
 *
 * The alias is the stable identity used to upsert AND the {alias} path segment.
 * rollbackData records, per action, the prior representation (null when we
 * registered it fresh in this realm) so rollback can restore the prior body or
 * fully de-register what was registered.
 */

interface PreviousEntry {
  alias: string
  prior: KeycloakRequiredActionRep | null
}

/** Fetch the live required action for an alias (or null on 404 / error), best-effort. */
async function fetchByAlias(
  admin: ReturnType<typeof buildAdminClient>,
  alias: string,
): Promise<KeycloakRequiredActionRep | null> {
  const res = await admin.get(`/authentication/required-actions/${encodeURIComponent(alias)}`)
  if (!res.ok) return null
  return parseJson<KeycloakRequiredActionRep>(res.body)
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
      if (!alias) continue

      const existing = await fetchByAlias(admin, alias)
      let base = existing

      if (!base) {
        const registerRes = await admin.post('/authentication/register-required-action', {
          providerId: alias,
          name,
        })
        if (!registerRes.ok) {
          throw new Error(
            `register ${alias} → HTTP ${registerRes.status}: ${registerRes.body.slice(0, 300)} (the provider may not exist on this server)`,
          )
        }
        base = await fetchByAlias(admin, alias)
        if (!base) throw new Error(`register ${alias} succeeded but the action could not be re-read`)
      }

      const rep = buildRequiredActionRep(item.fields, base)
      const res = await admin.put(`/authentication/required-actions/${encodeURIComponent(alias)}`, rep)
      if (!res.ok) throw new Error(`update ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)

      previous.push({ alias, prior: existing })
      applied.push(alias)
    }

    return {
      success: true,
      message: `Applied ${applied.length} required action(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Required action deploy failed after ${applied.length} action(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
