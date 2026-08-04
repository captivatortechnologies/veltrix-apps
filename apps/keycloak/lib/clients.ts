// =============================================================================
// Shared client UUID resolution.
//
// Several config types reference a Keycloak client by its human `clientId` (the
// identity operators know) but must operate against the client's internal UUID
// (the {id} path segment Keycloak assigns on create) — client-roles,
// protocol-mappers targeting a client, and authorization/resource-server. This
// mirrors config-types/clients/_shared.ts's own fetchByClientId, centralized here
// so those config types do not each re-implement it.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Clients" resource,
// GET /admin/realms/{realm}/clients?clientId=<id>).
// =============================================================================

import { parseJson } from './keycloakApi'
import type { KeycloakAdminClient } from './keycloakApi'

export interface KeycloakClientRef {
  /** Internal UUID — the {id} path segment for this client's sub-resources. */
  id?: string
  /** The human client identifier operators author against. */
  clientId?: string
  [key: string]: unknown
}

/**
 * Resolve a human `clientId` to its live client (internal UUID + representation),
 * or null when no client with that clientId exists. Best-effort — callers decide
 * whether a miss is a validation error, a skipped drift check, or a deploy failure.
 */
export async function resolveClientByClientId(
  admin: KeycloakAdminClient,
  clientId: string,
): Promise<KeycloakClientRef | null> {
  const target = clientId.trim()
  if (!target) return null
  const res = await admin.get(`/clients?clientId=${encodeURIComponent(target)}`)
  if (!res.ok) return null
  const list = parseJson<KeycloakClientRef[]>(res.body) ?? []
  return list.find((c) => String(c.clientId ?? '').trim() === target) ?? null
}
