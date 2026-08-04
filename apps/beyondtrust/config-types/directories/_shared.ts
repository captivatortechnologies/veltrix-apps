// Shared helpers for the Password Safe Directories config type (deploy +
// rollback + drift). Pure and network-free — the __tests__ exercise validate.ts
// and these helpers, none of which touch the network.
//
// A "Directory" here is the Password Safe / BeyondInsight record that binds an
// Active Directory / LDAP domain to a workgroup for account discovery and
// linked-account management (Configuration → Directories in the console) —
// NOT a filesystem path.
//
// SECRET MATERIAL DROPPED (PAM app posture): querying a directory needs a bind
// credential. BeyondInsight models that as a separate "Directory Credential"
// resource (Configuration → Role Based Access → Directory Credentials), stored
// and referenced independently of the Directory record itself — the public API
// reference for POST/PUT Directories does not carry a raw bind username/
// password in its body. This config type therefore authors only the directory
// BINDING (platform, domain, forest, NetBIOS name, connection settings) and
// never a credential; provision the matching Directory Credential out of band
// in BeyondInsight, same posture as the Directories page describing it as a
// prerequisite rather than part of this record.
//
// The parent is an EXISTING workgroup, referenced by name and resolved to its
// id at deploy time — same "resolve parent by name" shape used by
// managed-systems (this app) and e.g. the Keycloak app's protocol-mappers.
//
// PUT /Directories/{id} IS documented, so unlike functional-accounts/
// user-groups/workgroups this config type is a REAL upsert (create OR update);
// rollback can restore the prior field values for a directory it updated (not
// just delete one it created) — same shape as managed-accounts (this app).
//
// Endpoints follow the BeyondInsight / Password Safe public v3 API — verify
// against a live BeyondTrust instance:
//   GET    /Workgroups                       resolve the parent workgroup by name
//   GET    /Directories                      list all directories
//   POST   /Workgroups/{workgroupID}/Directories  create, scoped to that workgroup
//   PUT    /Directories/{id}                 update
//   DELETE /Directories/{id}                 delete (used best-effort by rollback)

/** One workgroup as returned by GET /Workgroups (duplicated locally — config
 * types never import from a sibling config-type folder). */
export interface WorkgroupRef {
  WorkgroupID?: number | string
  ID?: number | string
  Name?: string
  [key: string]: unknown
}

/** One directory as returned by GET /Directories. */
export interface Directory {
  DirectoryID?: number | string
  WorkgroupID?: number | string
  PlatformID?: number | string
  DomainName?: string
  ForestName?: string | null
  NetBiosName?: string | null
  Port?: number | null
  UseSSL?: boolean
  Timeout?: number | null
  Description?: string | null
  ContactEmail?: string | null
  PasswordRuleID?: number | null
  [key: string]: unknown
}

/** The create/update body sent to /Workgroups/{id}/Directories (POST) or /Directories/{id} (PUT). */
export interface DirectoryBody {
  PlatformID: number
  DomainName: string
  ForestName?: string
  NetBiosName?: string
  Port?: number
  UseSSL: boolean
  Timeout?: number
  Description?: string
  ContactEmail?: string
  PasswordRuleID?: number
}

/** Trim any value to a string. */
export function str(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas number/string to a positive integer, or null when not one. */
export function toPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Coerce a canvas number/string to a non-negative integer, or null when blank/invalid. */
export function toNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** Coerce a canvas checkbox/string to a boolean, defaulting to `fallback` when blank. */
export function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === null || value === undefined || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return fallback
}

/** Unwrap either a plain array or a `{ Data: [...] }` paginated container. */
export function listFrom<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && Array.isArray((data as { Data?: unknown }).Data)) {
    return (data as { Data: T[] }).Data
  }
  return []
}

/** Find a live workgroup by its (case-insensitive) name. */
export function findWorkgroupByName(workgroups: WorkgroupRef[], name: string): WorkgroupRef | null {
  const wanted = name.trim().toLowerCase()
  return workgroups.find((w) => str(w.Name).toLowerCase() === wanted) ?? null
}

/** The workgroup id, across response shapes. */
export function workgroupIdOf(workgroup: WorkgroupRef): number | string | null {
  return workgroup.WorkgroupID ?? workgroup.ID ?? null
}

/** A directory's identity is (workgroup, domain name) — the same domain could
 * legitimately be bound under a different workgroup. Case-folded on the domain. */
export function directoryIdentity(workgroupId: number | string, domainName: unknown): string {
  return `${workgroupId} ${str(domainName).toLowerCase()}`
}

/** Find a live directory by its (workgroup, domain name) identity. */
export function findDirectory(directories: Directory[], workgroupId: number | string, domainName: unknown): Directory | null {
  const wanted = directoryIdentity(workgroupId, domainName)
  return directories.find((d) => d.WorkgroupID != null && directoryIdentity(d.WorkgroupID, d.DomainName) === wanted) ?? null
}

/** Build the create/update body from canvas fields. */
export function buildDirectoryBody(fields: Record<string, unknown>): DirectoryBody {
  const body: DirectoryBody = {
    PlatformID: toPositiveInt(fields.platformId) ?? 0,
    DomainName: str(fields.domainName),
    UseSSL: toBool(fields.useSSL, false),
  }
  const forestName = str(fields.forestName)
  if (forestName) body.ForestName = forestName
  const netBiosName = str(fields.netBiosName)
  if (netBiosName) body.NetBiosName = netBiosName
  const port = toNonNegativeInt(fields.port)
  if (port !== null) body.Port = port
  const timeout = toNonNegativeInt(fields.timeout)
  if (timeout !== null) body.Timeout = timeout
  const description = str(fields.description)
  if (description) body.Description = description
  const contactEmail = str(fields.contactEmail)
  if (contactEmail) body.ContactEmail = contactEmail
  const passwordRuleId = toPositiveInt(fields.passwordRuleId)
  if (passwordRuleId !== null) body.PasswordRuleID = passwordRuleId
  return body
}

/** Project the fields this config type manages off a live directory, for drift comparison. */
export interface DirectoryProjection {
  forestName: string
  netBiosName: string
  port: number | null
  useSSL: boolean
  timeout: number | null
  description: string
  contactEmail: string
  passwordRuleId: number | null
}

export function projectFromFields(fields: Record<string, unknown>): DirectoryProjection {
  return {
    forestName: str(fields.forestName),
    netBiosName: str(fields.netBiosName),
    port: toNonNegativeInt(fields.port),
    useSSL: toBool(fields.useSSL, false),
    timeout: toNonNegativeInt(fields.timeout),
    description: str(fields.description),
    contactEmail: str(fields.contactEmail),
    passwordRuleId: toPositiveInt(fields.passwordRuleId),
  }
}

export function projectFromLive(directory: Directory): DirectoryProjection {
  return {
    forestName: str(directory.ForestName),
    netBiosName: str(directory.NetBiosName),
    port: typeof directory.Port === 'number' ? directory.Port : null,
    useSSL: Boolean(directory.UseSSL),
    timeout: typeof directory.Timeout === 'number' ? directory.Timeout : null,
    description: str(directory.Description),
    contactEmail: str(directory.ContactEmail),
    passwordRuleId: typeof directory.PasswordRuleID === 'number' ? directory.PasswordRuleID : null,
  }
}
