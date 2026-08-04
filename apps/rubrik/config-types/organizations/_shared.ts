// Shared helpers for the Rubrik Organizations config type (deploy + rollback + drift).
//
// A Rubrik Organization is a lightweight multi-tenancy container: cluster admins
// create one per tenant/business-unit and then scope SLA domains, filesets and
// users to it. The verified public surface is minimal — an organization has only
// a NAME; there is no verified rename/update endpoint, so the name is treated as
// immutable identity (an org whose declared name already exists on the cluster
// is left untouched; a new name creates a new organization).
//
// Managed over the Rubrik CDM internal REST API:
//   list:   GET    /api/internal/organization
//   create: POST   /api/internal/organization   { name }
//   delete: DELETE /api/internal/organization/{id}
//
// Endpoints verified against the Rubrik PowerShell SDK's API data for
// Get-RubrikOrganization / New-RubrikOrganization / Remove-RubrikOrganization
// (rubrikinc/rubrik-sdk-for-powershell, Rubrik/Private/Get-RubrikAPIData.ps1).
//
// FLAG (verify against a live Rubrik CDM cluster): whether a later CDM version
// added a rename endpoint — none of the community SDKs consulted (PowerShell,
// Python) expose one, only create/list/delete. Assigning objects, SLA domains or
// users TO an organization (/internal/authorization/role/organization) is a
// separate, security-sensitive RBAC grant and is intentionally out of scope —
// see the app README "Coverage" section.

export interface RubrikOrganization {
  id?: string
  name?: string
  isGlobal?: boolean
  [key: string]: unknown
}

/** Trim + normalize a value for stable identity matching. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim()
}

/** Build the create-request body — an organization's only declarative field is its name. */
export function buildOrganizationBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { name: normalizeName(fields.name) }
}

/** Unwrap the internal list envelope ({ data, total, hasMore }) into a flat array. */
export function organizationsFromList(resp: unknown): RubrikOrganization[] {
  if (Array.isArray(resp)) return resp as RubrikOrganization[]
  if (resp && typeof resp === 'object' && Array.isArray((resp as { data?: unknown }).data)) {
    return (resp as { data: RubrikOrganization[] }).data
  }
  return []
}

/** Find a live organization by its (case-sensitive, trimmed) name; null when absent. */
export function findOrganizationByName(list: RubrikOrganization[], name: string): RubrikOrganization | null {
  const n = normalizeName(name)
  if (!n) return null
  return list.find((o) => normalizeName(o.name) === n) ?? null
}
