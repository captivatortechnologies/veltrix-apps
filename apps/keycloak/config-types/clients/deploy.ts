import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { buildClientRep, findClientByClientId, type KeycloakClientRep } from './_shared'

/**
 * Deploy Keycloak clients over the Admin REST API:
 *   read (identity):  GET  /clients?clientId=<clientId>  → find the live client
 *   create:           POST /clients                       with a ClientRepresentation
 *   update:           PUT  /clients/{id}                  with a merged ClientRepresentation
 *
 * The clientId is the stable identity used to upsert. rollbackData records, per
 * client, the prior representation (null when it did not exist) AND the internal
 * id — so rollback can restore the prior body or delete the one we created.
 */

/** One rollback entry: the prior representation (or null if created) + internal id. */
interface PreviousEntry {
  clientId: string
  id: string | null
  client: KeycloakClientRep | null
}

/** Fetch the live client for a clientId (or null), best-effort. */
async function fetchByClientId(
  client: ReturnType<typeof buildAdminClient>,
  clientId: string,
): Promise<KeycloakClientRep | null> {
  const res = await client.get(`/clients?clientId=${encodeURIComponent(clientId)}`)
  if (!res.ok) return null
  const list = parseJson<KeycloakClientRep[]>(res.body) ?? []
  return findClientByClientId(list, clientId)
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
      const clientId = String(item.fields.clientId ?? '').trim()
      if (!clientId) continue

      const existing = await fetchByClientId(admin, clientId)

      if (existing && existing.id) {
        const rep = buildClientRep(item.fields, existing)
        const res = await admin.put(`/clients/${encodeURIComponent(existing.id)}`, rep)
        if (!res.ok) throw new Error(`update ${clientId} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        previous.push({ clientId, id: existing.id, client: existing })
      } else {
        const rep = buildClientRep(item.fields)
        const res = await admin.post('/clients', rep)
        if (!res.ok) throw new Error(`create ${clientId} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        // Keycloak's 201 returns the new id only in the Location header; re-read by
        // clientId to capture it for rollback (delete-what-we-created).
        const created = await fetchByClientId(admin, clientId)
        previous.push({ clientId, id: created?.id ?? null, client: null })
      }
      applied.push(clientId)
    }

    return {
      success: true,
      message: `Applied ${applied.length} client(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Client deploy failed after ${applied.length} client(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
