// Shared helpers for the Password Safe Workgroups config type (deploy + rollback
// + drift). Pure and network-free — the __tests__ exercise validate.ts and these
// helpers, none of which touch the network.
//
// Workgroups are the BeyondInsight containers that organize assets and managed
// systems. Create is clean (a name, plus an optional organization GUID for
// multi-tenant installs).
//
// Endpoints follow the BeyondInsight / Password Safe public v3 API — verify
// against a live BeyondTrust instance:
//   GET  /Workgroups        list all workgroups
//   POST /Workgroups        create { Name (max 256), OrganizationID? (guid) }
//
// FLAGGED: Password Safe exposes NO update (PUT) and NO delete (DELETE) endpoint
// for a workgroup. So this is a create-if-absent upsert, and rollback CANNOT
// remove a workgroup it created — the created names are recorded and reported,
// never silently forgotten. (Verified against the BeyondInsight API reference,
// which lists only GET and POST for the Workgroups resource.)

/** Max length from the BeyondInsight API guide (POST Workgroups, Name). */
export const WORKGROUP_NAME_MAX = 256

/** A canonical GUID (used for the optional OrganizationID). */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** One workgroup as returned by GET /Workgroups. */
export interface Workgroup {
  OrganizationID?: string | null
  ID?: number | string
  Name?: string
  Description?: string | null
  [key: string]: unknown
}

/** The create body POSTed to /Workgroups (built from canvas fields, blanks omitted). */
export interface WorkgroupCreate {
  Name: string
  OrganizationID?: string
}

/** Trim any value to a string. */
export function str(value: unknown): string {
  return String(value ?? '').trim()
}

/** True when the value is a well-formed GUID. */
export function isGuid(value: unknown): boolean {
  return GUID_RE.test(str(value))
}

/** A workgroup's identity is its name, case-folded (workgroup names are unique). */
export function workgroupIdentity(name: unknown): string {
  return str(name).toLowerCase()
}

/** Unwrap either a plain array or a `{ Data: [...] }` paginated container. */
export function workgroupsFromList(data: unknown): Workgroup[] {
  if (Array.isArray(data)) return data as Workgroup[]
  if (data && typeof data === 'object' && Array.isArray((data as { Data?: unknown }).Data)) {
    return (data as { Data: Workgroup[] }).Data
  }
  return []
}

/** Find a live workgroup by its (case-insensitive) name. */
export function findWorkgroup(workgroups: Workgroup[], name: unknown): Workgroup | null {
  const wanted = workgroupIdentity(name)
  return workgroups.find((w) => workgroupIdentity(w.Name) === wanted) ?? null
}

/** Build the /Workgroups create body from canvas fields (organization omitted when blank). */
export function buildCreateBody(fields: Record<string, unknown>): WorkgroupCreate {
  const body: WorkgroupCreate = { Name: str(fields.name) }
  const org = str(fields.organizationId)
  if (org) body.OrganizationID = org
  return body
}
